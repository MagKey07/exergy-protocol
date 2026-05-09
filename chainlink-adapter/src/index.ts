#!/usr/bin/env node
/**
 * @file index.ts
 * @description CLI entrypoint for the Exergy Chainlink External Adapter.
 *
 * Commands:
 *   start            Boot the HTTP server. POST /submit accepts dual-signed packets.
 *   health           One-shot status print (uses the same env as `start`).
 *   tx-status <hash> Resolve a previously-relayed tx hash on the configured RPC.
 *
 * Environment:
 *   ARBITRUM_RPC_URL          RPC endpoint (localhost / Sepolia / mainnet).
 *   ARBITRUM_CHAIN_ID         (optional) chain id, surfaced in /health.
 *   RELAYER_PRIVATE_KEY       Funded EOA holding CHAINLINK_RELAYER_ROLE.
 *   ORACLE_ROUTER_ADDRESS     Deployed OracleRouter proxy address.
 *   ADAPTER_PORT              HTTP listen port (default 9000).
 *   ADAPTER_HOST              HTTP listen host (default 127.0.0.1).
 *   DRY_RUN=1                 Verify + run consensus, but skip the on-chain tx.
 *   SUBMIT_MAX_RETRIES        RPC retry budget (default 3).
 *   SUBMIT_RETRY_BACKOFF_MS   Backoff multiplier in ms (default 1500).
 *   DSO_NOISE_RANGE           "lo,hi" multiplicative range (default 0.95,1.05).
 *
 * NOTE: All consensus / DSO threshold parameters are HARD-CODED CONSTANTS in
 *       src/types.ts. No CLI flag exposes them — that is intentional per
 *       CORE_THESIS §5.5 ("no human reviews, no subjective decisions").
 */
import 'dotenv/config';
import { Command } from 'commander';
import { Relayer } from './relayer';
import { buildApp } from './server';
import type { AdapterConfig } from './types';
import { logger, child } from './logger';

const log = child('cli');

function readConfig(overrides: Partial<AdapterConfig> = {}): AdapterConfig {
  const rpcUrl = process.env.ARBITRUM_RPC_URL ?? 'http://127.0.0.1:8545';
  const chainId = Number(process.env.ARBITRUM_CHAIN_ID ?? 31337);
  const oracleRouterAddress = process.env.ORACLE_ROUTER_ADDRESS ?? '';
  const relayerPrivateKey = process.env.RELAYER_PRIVATE_KEY ?? '';
  const port = Number(process.env.ADAPTER_PORT ?? 9000);
  const host = process.env.ADAPTER_HOST ?? '127.0.0.1';
  const dryRun = process.env.DRY_RUN === '1';
  const maxRetries = Number(process.env.SUBMIT_MAX_RETRIES ?? 3);
  const retryBackoffMs = Number(process.env.SUBMIT_RETRY_BACKOFF_MS ?? 1500);
  const dsoNoiseRange = parseRange(process.env.DSO_NOISE_RANGE ?? '0.95,1.05');

  return {
    rpcUrl,
    chainId,
    oracleRouterAddress,
    relayerPrivateKey,
    port,
    host,
    dryRun,
    maxRetries,
    retryBackoffMs,
    dsoNoiseRange,
    ...overrides,
  };
}

function parseRange(raw: string): readonly [number, number] {
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 2 || parts.some((v) => !Number.isFinite(v))) {
    throw new Error(`DSO_NOISE_RANGE invalid: ${raw} (expected "lo,hi")`);
  }
  const [lo, hi] = parts as [number, number];
  if (lo > hi) throw new Error(`DSO_NOISE_RANGE lo > hi: ${raw}`);
  return [lo, hi];
}

const program = new Command();
program
  .name('exergy-chainlink-adapter')
  .description('Mock Chainlink External Adapter — verifies, achieves consensus, relays on-chain.')
  .version('0.1.0');

program
  .command('start')
  .description('Start the HTTP adapter server. Long-running.')
  .option('-p, --port <number>', 'override ADAPTER_PORT')
  .option('-h, --host <string>', 'override ADAPTER_HOST')
  .action((opts: { port?: string; host?: string }) => {
    const cfg = readConfig({
      port: opts.port ? Number(opts.port) : undefined,
      host: opts.host ?? undefined,
    });
    if (!cfg.oracleRouterAddress.startsWith('0x')) {
      throw new Error('ORACLE_ROUTER_ADDRESS env not set');
    }
    if (!cfg.relayerPrivateKey) throw new Error('RELAYER_PRIVATE_KEY env not set');

    const relayer = new Relayer(cfg);
    const app = buildApp(cfg, relayer);
    app.listen(cfg.port, cfg.host, () => {
      log.info('adapter listening', {
        host: cfg.host,
        port: cfg.port,
        oracleRouter: cfg.oracleRouterAddress,
        relayer: relayer.address,
        chainId: cfg.chainId,
        dryRun: cfg.dryRun,
      });
    });
  });

program
  .command('health')
  .description('Print one-shot adapter health status (no server).')
  .action(async () => {
    const cfg = readConfig();
    if (!cfg.oracleRouterAddress.startsWith('0x')) {
      throw new Error('ORACLE_ROUTER_ADDRESS env not set');
    }
    if (!cfg.relayerPrivateKey) throw new Error('RELAYER_PRIVATE_KEY env not set');
    const relayer = new Relayer(cfg);
    const role = await relayer.hasRelayerRole();
    log.info('health', {
      relayerAddress: relayer.address,
      hasRelayerRole: role,
      oracleRouter: cfg.oracleRouterAddress,
      chainId: cfg.chainId,
    });
  });

program
  .command('tx-status <hash>')
  .description('Resolve receipt for a tx hash on the configured RPC.')
  .action(async (hash: string) => {
    const cfg = readConfig();
    const relayer = new Relayer(cfg);
    const status = await relayer.getTxStatus(hash);
    log.info('tx-status', { hash, ...status });
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  logger.error('fatal', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
