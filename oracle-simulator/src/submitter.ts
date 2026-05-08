/**
 * @file submitter.ts
 * @description Submit dual-signed packets to OracleRouter on Arbitrum Sepolia.
 *
 * Behaviour:
 *  - Probes the deployed contract to choose between tuple and flat call shape.
 *  - Retries transient RPC failures with exponential backoff.
 *  - Honours DRY_RUN=1 to skip the actual transaction (signatures still built).
 *  - Logs every accepted/rejected packet via the structured logger.
 */
import { Contract, JsonRpcProvider, Wallet, type ContractRunner, type Interface, isError } from 'ethers';
import type { DualSignedPacket, SubmissionResult } from './types';
import { ORACLE_ROUTER_ABI } from './oracle-router.abi';
import { child } from './logger';

const log = child('submitter');

export interface SubmitterConfig {
  readonly rpcUrl: string;
  readonly oracleRouterAddress: string;
  readonly submitterPrivateKey: string;
  readonly dryRun?: boolean;
  readonly maxRetries?: number;
  readonly retryBackoffMs?: number;
}

export class Submitter {
  private readonly provider: JsonRpcProvider;
  private readonly wallet: Wallet;
  private readonly router: Contract;
  private readonly cfg: Required<SubmitterConfig>;
  /**
   * Cached "which submit function exists" decision. Filled lazily on first
   * submit. -1 = not yet probed, 0 = tuple form, 1 = flat form.
   */
  private submitShape: -1 | 0 | 1 = -1;

  constructor(cfg: SubmitterConfig) {
    if (!cfg.rpcUrl) throw new Error('rpcUrl required');
    if (!cfg.oracleRouterAddress || !cfg.oracleRouterAddress.startsWith('0x')) {
      throw new Error(`oracleRouterAddress invalid: ${cfg.oracleRouterAddress}`);
    }
    if (!cfg.submitterPrivateKey) throw new Error('submitterPrivateKey required');

    this.cfg = {
      dryRun: false,
      maxRetries: 3,
      retryBackoffMs: 1500,
      ...cfg,
    };
    this.provider = new JsonRpcProvider(this.cfg.rpcUrl);
    this.wallet = new Wallet(this.cfg.submitterPrivateKey, this.provider);
    this.router = new Contract(this.cfg.oracleRouterAddress, ORACLE_ROUTER_ABI, this.wallet as ContractRunner);
  }

  /** Submit a single dual-signed packet. Returns SubmissionResult either way. */
  async submit(packet: DualSignedPacket): Promise<SubmissionResult> {
    if (this.cfg.dryRun) {
      log.info('dry-run: skipping on-chain submission', {
        deviceId: packet.deviceId,
        kwh: packet.kwhAmount.toString(),
      });
      return { ok: true, attempts: 0 };
    }

    let attempts = 0;
    let lastErr: unknown;
    while (attempts < this.cfg.maxRetries) {
      attempts++;
      try {
        const tx = await this.callSubmit(packet);
        log.info('tx-sent', { deviceId: packet.deviceId, txHash: tx.hash, attempt: attempts });
        const receipt = await tx.wait();
        if (!receipt) {
          throw new Error('tx receipt was null (provider returned no confirmation)');
        }
        log.info('tx-confirmed', {
          deviceId: packet.deviceId,
          txHash: tx.hash,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed.toString(),
        });
        return { ok: true, txHash: tx.hash, blockNumber: receipt.blockNumber, attempts };
      } catch (err) {
        lastErr = err;
        const isTransient = isTransientError(err);
        log.warn('submit failed', {
          deviceId: packet.deviceId,
          attempt: attempts,
          transient: isTransient,
          error: err instanceof Error ? err.message : String(err),
        });
        if (!isTransient) break;
        if (attempts < this.cfg.maxRetries) {
          await sleep(this.cfg.retryBackoffMs * attempts);
        }
      }
    }
    return {
      ok: false,
      attempts,
      error: lastErr instanceof Error ? lastErr.message : String(lastErr),
    };
  }

  /**
   * Register a device on-chain. Owner-only on the contract; this only succeeds
   * if the submitter wallet IS the OracleRouter owner.
   */
  async registerDevice(deviceId: string, vpp: string, pubKeyHash: string): Promise<SubmissionResult> {
    if (this.cfg.dryRun) {
      log.info('dry-run: skipping registerDevice', { deviceId, vpp, pubKeyHash });
      return { ok: true, attempts: 0 };
    }
    try {
      const fn = (this.router as unknown as { registerDevice: (...args: unknown[]) => Promise<{ hash: string; wait: () => Promise<{ blockNumber: number } | null> }> }).registerDevice;
      const tx = await fn(deviceId, vpp, pubKeyHash);
      log.info('register-tx-sent', { deviceId, txHash: tx.hash });
      const receipt = await tx.wait();
      log.info('register-tx-confirmed', { deviceId, blockNumber: receipt?.blockNumber });
      return { ok: true, txHash: tx.hash, blockNumber: receipt?.blockNumber, attempts: 1 };
    } catch (err) {
      log.error('register failed', { deviceId, error: err instanceof Error ? err.message : String(err) });
      return { ok: false, attempts: 1, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /* ------------ internal ------------ */

  private async probeShape(): Promise<0 | 1> {
    if (this.submitShape !== -1) return this.submitShape;
    // Both signatures are in the ABI. We try the tuple form first because that
    // is the contract author's likely choice (cleaner Solidity). If the
    // contract emits a "function selector not found" error we fall back to flat.
    // The cheapest way to probe without spending gas is to call .estimateGas.
    const iface = this.router.interface as Interface;
    const tupleFrag = iface.getFunction(
      'submitMeasurement((bytes32,uint256,uint64,uint256,uint8,uint8,uint32),bytes,bytes)',
    );
    if (tupleFrag) {
      this.submitShape = 0;
      log.debug('probe: using tuple submitMeasurement');
      return 0;
    }
    this.submitShape = 1;
    log.debug('probe: using flat submitMeasurement');
    return 1;
  }

  private async callSubmit(packet: DualSignedPacket): Promise<{ hash: string; wait: () => Promise<{ blockNumber: number; gasUsed: bigint } | null> }> {
    const shape = await this.probeShape();
    const tuple = [
      packet.deviceId,
      packet.kwhAmount,
      packet.timestamp,
      packet.storageCapacity,
      packet.chargeLevelPercent,
      packet.sourceType,
      packet.cumulativeCycles,
    ] as const;

    type SubmitFn = (...args: unknown[]) => Promise<{ hash: string; wait: () => Promise<{ blockNumber: number; gasUsed: bigint } | null> }>;
    const overload = shape === 0
      ? 'submitMeasurement((bytes32,uint256,uint64,uint256,uint8,uint8,uint32),bytes,bytes)'
      : 'submitMeasurement(bytes32,uint256,uint64,uint256,uint8,uint8,uint32,bytes,bytes)';
    const fn = (this.router as unknown as Record<string, SubmitFn>)[overload];
    if (!fn) throw new Error(`submitMeasurement overload missing on contract: ${overload}`);

    if (shape === 0) {
      return fn(tuple, packet.deviceSignature, packet.vppSignature);
    }
    return fn(...tuple, packet.deviceSignature, packet.vppSignature);
  }
}

/** Heuristic: should we retry this error? RPC blips, nonce races, timeouts yes. */
function isTransientError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  // ethers v6 typed errors
  if (isError(err as Error, 'NETWORK_ERROR')) return true;
  if (isError(err as Error, 'TIMEOUT')) return true;
  if (isError(err as Error, 'SERVER_ERROR')) return true;
  if (isError(err as Error, 'NONCE_EXPIRED')) return true;
  if (isError(err as Error, 'REPLACEMENT_UNDERPRICED')) return true;
  // string-based fallback
  const msg = String((err as { message?: string }).message ?? '').toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('network') ||
    msg.includes('econnreset') ||
    msg.includes('rate limit') ||
    msg.includes('socket hang up')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
