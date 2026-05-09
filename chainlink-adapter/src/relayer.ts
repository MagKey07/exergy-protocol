/**
 * @file relayer.ts
 * @description On-chain relay of accepted packets to OracleRouter.
 *
 * The relayer holds CHAINLINK_RELAYER_ROLE on OracleRouter. On every accepted
 * packet (post-verifier + post-consensus) it calls
 *
 *    OracleRouter.submitMeasurement(packet, deviceSig, vppSig)
 *
 * The contract repeats the dual-signature verification on-chain — this
 * relayer is ADDITIVE security, not a replacement. If the relayer key is
 * compromised, the worst an attacker can do is:
 *   (a) forward genuinely-dual-signed packets faster, or
 *   (b) refuse to forward genuine packets (a liveness DOS — the protocol
 *       responds by allowing other relayers to be granted the role through
 *       governance; concept-wise this is the SMTP analogy from CORE_THESIS).
 *
 * The relayer CANNOT mint without a valid dual signature recovered to a
 * registered (device, vpp) pair, because the contract verifies that
 * regardless of which address called `submitMeasurement`.
 */
import { Contract, JsonRpcProvider, Wallet, isError, type ContractRunner } from 'ethers';
import type { AdapterConfig, MeasurementPacket } from './types';
import { ORACLE_ROUTER_ABI } from './oracle-router.abi';
import { child } from './logger';

const log = child('relayer');

/** What the caller gets back per relay attempt. */
export interface RelayResult {
  readonly ok: boolean;
  readonly txHash?: string;
  readonly blockNumber?: number;
  readonly attempts: number;
  readonly error?: string;
}

export class Relayer {
  private readonly provider: JsonRpcProvider;
  private readonly wallet: Wallet;
  private readonly router: Contract;

  constructor(private readonly cfg: AdapterConfig) {
    if (!cfg.rpcUrl) throw new Error('rpcUrl required');
    if (!cfg.oracleRouterAddress.startsWith('0x')) {
      throw new Error(`oracleRouterAddress invalid: ${cfg.oracleRouterAddress}`);
    }
    if (!cfg.relayerPrivateKey) throw new Error('relayerPrivateKey required');
    this.provider = new JsonRpcProvider(cfg.rpcUrl);
    this.wallet = new Wallet(cfg.relayerPrivateKey, this.provider);
    this.router = new Contract(
      cfg.oracleRouterAddress,
      ORACLE_ROUTER_ABI,
      this.wallet as ContractRunner,
    );
  }

  /** The address the relayer will call from — used by /health to assert role. */
  get address(): string {
    return this.wallet.address;
  }

  /**
   * Relay a packet on-chain. Retries transient RPC errors; propagates revert
   * errors immediately (a contract revert is deterministic — retrying won't
   * help and would just burn gas / pollute logs).
   */
  async relay(
    packet: MeasurementPacket,
    deviceSignature: string,
    vppSignature: string,
  ): Promise<RelayResult> {
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
        const tuple = [
          packet.deviceId,
          packet.kwhAmount,
          packet.timestamp,
          packet.storageCapacity,
          packet.chargeLevelPercent,
          packet.sourceType,
          packet.cumulativeCycles,
        ] as const;

        type SubmitFn = (...args: unknown[]) => Promise<{
          hash: string;
          wait: () => Promise<{ blockNumber: number; gasUsed: bigint } | null>;
        }>;
        const overload = 'submitMeasurement((bytes32,uint256,uint64,uint256,uint8,uint8,uint32),bytes,bytes)';
        const fn = (this.router as unknown as Record<string, SubmitFn>)[overload];
        if (!fn) throw new Error(`submitMeasurement overload missing on contract: ${overload}`);

        const tx = await fn(tuple, deviceSignature, vppSignature);
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
        return {
          ok: true,
          txHash: tx.hash,
          blockNumber: receipt.blockNumber,
          attempts,
        };
      } catch (err) {
        lastErr = err;
        const transient = isTransientError(err);
        log.warn('relay failed', {
          deviceId: packet.deviceId,
          attempt: attempts,
          transient,
          error: err instanceof Error ? err.message : String(err),
        });
        if (!transient) break;
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
   * Convenience: return tx receipt for a previously-submitted hash. Used by
   * the `tx-status` CLI command.
   */
  async getTxStatus(hash: string): Promise<{
    found: boolean;
    blockNumber?: number;
    status?: number;
    confirmations?: number;
  }> {
    const receipt = await this.provider.getTransactionReceipt(hash);
    if (!receipt) return { found: false };
    return {
      found: true,
      blockNumber: receipt.blockNumber,
      status: receipt.status ?? undefined,
      confirmations: await receipt.confirmations(),
    };
  }

  /**
   * Best-effort role check — useful in /health to surface misconfiguration.
   * On testnet networks where eth_call fails (RPC down, contract not yet
   * deployed) this returns `unknown`.
   */
  async hasRelayerRole(): Promise<'yes' | 'no' | 'unknown'> {
    try {
      const role = await (this.router as unknown as { CHAINLINK_RELAYER_ROLE: () => Promise<string> })
        .CHAINLINK_RELAYER_ROLE();
      const ok = await (this.router as unknown as {
        hasRole: (role: string, account: string) => Promise<boolean>;
      }).hasRole(role, this.wallet.address);
      return ok ? 'yes' : 'no';
    } catch (err) {
      log.warn('hasRelayerRole probe failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 'unknown';
    }
  }
}

function isTransientError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if (isError(err as Error, 'NETWORK_ERROR')) return true;
  if (isError(err as Error, 'TIMEOUT')) return true;
  if (isError(err as Error, 'SERVER_ERROR')) return true;
  if (isError(err as Error, 'NONCE_EXPIRED')) return true;
  if (isError(err as Error, 'REPLACEMENT_UNDERPRICED')) return true;
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
