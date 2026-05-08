#!/usr/bin/env node
/**
 * @file index.ts
 * @description CLI entry point for the Exergy oracle simulator.
 *
 * Commands:
 *   simulate-vpp     Continuous fleet simulation (multiple devices, N hours sim time).
 *   single-packet    One-shot: emit a single dual-signed packet.
 *   register-device  Owner-only: register deviceId -> vpp + pubKeyHash on-chain.
 */
import 'dotenv/config';
import { Command } from 'commander';
import { BatterySim } from './battery-sim';
import { EdgeDevice } from './edge-device';
import { VppCloud, DeviceRegistry } from './vpp-cloud';
import { Submitter } from './submitter';
import { deviceFleet, deviceIdFromLabel, fromPrivateKey, fromSeed, type Keypair } from './keypair';
import { SourceType } from './types';
import { logger, child } from './logger';

const log = child('cli');

interface EnvCfg {
  rpcUrl: string;
  oracleRouterAddress: string;
  submitterPrivateKey: string;
  vppCloudPrivateKey: string;
  devicePrivateKey: string | undefined;
  dryRun: boolean;
  maxRetries: number;
  retryBackoffMs: number;
}

function readEnv(): EnvCfg {
  const rpcUrl = process.env.ARBITRUM_SEPOLIA_RPC_URL ?? '';
  const oracleRouterAddress = process.env.ORACLE_ROUTER_ADDRESS ?? '';
  const submitterPrivateKey = process.env.SUBMITTER_PRIVATE_KEY ?? '';
  const vppCloudPrivateKey = process.env.VPP_CLOUD_PRIVATE_KEY ?? submitterPrivateKey;
  const devicePrivateKey = process.env.DEVICE_PRIVATE_KEY || undefined;
  const dryRun = process.env.DRY_RUN === '1';
  const maxRetries = Number(process.env.SUBMIT_MAX_RETRIES ?? 3);
  const retryBackoffMs = Number(process.env.SUBMIT_RETRY_BACKOFF_MS ?? 1500);
  return { rpcUrl, oracleRouterAddress, submitterPrivateKey, vppCloudPrivateKey, devicePrivateKey, dryRun, maxRetries, retryBackoffMs };
}

function buildSubmitter(env: EnvCfg): Submitter {
  return new Submitter({
    rpcUrl: env.rpcUrl,
    oracleRouterAddress: env.oracleRouterAddress,
    submitterPrivateKey: env.submitterPrivateKey,
    dryRun: env.dryRun,
    maxRetries: env.maxRetries,
    retryBackoffMs: env.retryBackoffMs,
  });
}

function parseSource(s: string): SourceType {
  switch (s.toLowerCase()) {
    case 'solar': return SourceType.Solar;
    case 'wind': return SourceType.Wind;
    case 'hydro': return SourceType.Hydro;
    case 'other': return SourceType.Other;
    default: throw new Error(`unknown source ${s}; expected solar|wind|hydro|other`);
  }
}

const program = new Command();
program
  .name('exergy-oracle-sim')
  .description('Exergy Protocol oracle simulator — mock device → edge → VPP cloud → on-chain.')
  .version('0.1.0');

/* ---------------- simulate-vpp ---------------- */
program
  .command('simulate-vpp')
  .description('Run continuous fleet simulation against a single VPP cloud identity.')
  .requiredOption('--vpp <label>', 'VPP label (used to derive deterministic VPP key + device fleet)')
  .option('--devices <count>', 'number of mock devices', (v) => parseInt(v, 10), 5)
  .option('--duration <hours>', 'simulated wall-clock hours to run', (v) => parseInt(v, 10), 24)
  .option('--rate <packetsPerHour>', 'packets emitted per device per simulated hour', (v) => parseFloat(v), 1)
  .option('--source <type>', 'solar|wind|hydro|other', 'solar')
  .option('--latitude <deg>', 'geographic latitude for solar curve', (v) => parseFloat(v), 30)
  .option('--tz <hours>', 'timezone offset hours', (v) => parseFloat(v), 0)
  .option('--capacity <kwh>', 'device storage capacity in kWh', (v) => parseFloat(v), 13.5)
  .option('--charge <kw>', 'device charge rate kW', (v) => parseFloat(v), 5)
  .option('--discharge <kw>', 'device discharge rate kW', (v) => parseFloat(v), 5)
  .option('--initial-soc <pct>', 'initial state-of-charge percent', (v) => parseFloat(v), 30)
  .option('--attacker-device <label>', 'optional: one device that reports impossible energy', '')
  .action(async (opts: {
    vpp: string;
    devices: number;
    duration: number;
    rate: number;
    source: string;
    latitude: number;
    tz: number;
    capacity: number;
    charge: number;
    discharge: number;
    initialSoc: number;
    attackerDevice: string;
  }) => {
    const env = readEnv();
    const source = parseSource(opts.source);
    const vppKeypair = fromSeed(`vpp:${opts.vpp}`);
    log.info('vpp identity', { label: opts.vpp, address: vppKeypair.address });

    // Build fleet + registry.
    const fleet = deviceFleet(opts.vpp, opts.devices);
    const registry = new DeviceRegistry();
    for (const d of fleet) registry.register(d.deviceId, d.keypair.address);
    log.info('fleet built', { vpp: opts.vpp, devices: fleet.length });

    const cloud = new VppCloud(vppKeypair, registry);
    const submitter = env.oracleRouterAddress.replace(/0+$/, '').length > 2
      ? buildSubmitter(env)
      : null;
    if (!submitter) {
      log.warn('ORACLE_ROUTER_ADDRESS not set — running in offline mode (no on-chain submit)');
    }

    // Build per-device simulators + edge devices.
    const startUnixSec = BigInt(Math.floor(Date.now() / 1000));
    const sims = fleet.map((d, idx) => ({
      label: d.label,
      device: new EdgeDevice(d.keypair),
      sim: new BatterySim(
        {
          deviceId: d.deviceId,
          capacityKwh: opts.capacity,
          chargeRateKw: opts.charge,
          dischargeRateKw: opts.discharge,
          source,
          initialSocPercent: opts.initialSoc,
          initialCycles: 0,
          latitudeDeg: opts.latitude,
          timezoneOffsetHours: opts.tz,
          seed: hashStringToInt(d.label),
        },
        {
          startUnixSec,
          attackerMode: opts.attackerDevice !== '' && d.label === opts.attackerDevice,
        },
      ),
      idx,
    }));

    const tickHours = 1 / Math.max(opts.rate, 0.0001);
    const totalTicks = Math.ceil(opts.duration / tickHours);
    log.info('starting simulation', {
      totalTicks,
      tickHours,
      durationHours: opts.duration,
      packetsPerHour: opts.rate,
    });

    let accepted = 0;
    let rejected = 0;
    let submitted = 0;
    let submitErrors = 0;

    for (let t = 0; t < totalTicks; t++) {
      const signedBatch = await Promise.all(sims.map(async (s) => {
        const { reading, anomalies } = s.sim.tick(tickHours);
        if (anomalies.length > 0) {
          log.warn('simulator anomaly', { device: s.label, anomalies });
        }
        return s.device.sign(reading);
      }));

      const cosignResult = await cloud.cosignBatch(signedBatch);
      accepted += cosignResult.accepted.length;
      rejected += cosignResult.rejected.length;

      if (submitter) {
        for (const p of cosignResult.accepted) {
          const r = await submitter.submit(p);
          if (r.ok) submitted++;
          else submitErrors++;
        }
      }

      if ((t + 1) % 10 === 0 || t === totalTicks - 1) {
        log.info('progress', {
          tick: t + 1,
          totalTicks,
          accepted,
          rejected,
          submitted,
          submitErrors,
        });
      }
    }

    log.info('done', { accepted, rejected, submitted, submitErrors });
  });

/* ---------------- single-packet ---------------- */
program
  .command('single-packet')
  .description('Emit one dual-signed packet (smoke test).')
  .requiredOption('--device <label>', 'device label (deterministic id derived from this)')
  .requiredOption('--vpp <label>', 'VPP label (deterministic VPP key)')
  .option('--kwh <amount>', 'kWh charged in this measurement window', (v) => parseFloat(v), 2.5)
  .option('--source <type>', 'solar|wind|hydro|other', 'solar')
  .option('--capacity <kwh>', 'storage capacity in kWh', (v) => parseFloat(v), 13.5)
  .option('--soc <pct>', 'state of charge percent at measurement time', (v) => parseFloat(v), 65)
  .option('--cycles <n>', 'cumulative cycles', (v) => parseInt(v, 10), 12)
  .action(async (opts: {
    device: string;
    vpp: string;
    kwh: number;
    source: string;
    capacity: number;
    soc: number;
    cycles: number;
  }) => {
    const env = readEnv();
    const source = parseSource(opts.source);
    const deviceKey: Keypair = env.devicePrivateKey
      ? fromPrivateKey(env.devicePrivateKey)
      : fromSeed(opts.device);
    const vppKey = fromSeed(`vpp:${opts.vpp}`);
    const deviceId = deviceIdFromLabel(opts.device);
    log.info('identities', {
      device: { label: opts.device, address: deviceKey.address, deviceId },
      vpp: { label: opts.vpp, address: vppKey.address },
    });

    const registry = new DeviceRegistry();
    registry.register(deviceId, deviceKey.address);
    const edge = new EdgeDevice(deviceKey);
    const cloud = new VppCloud(vppKey, registry);

    const reading = {
      deviceId,
      kwhAmount: BigInt(Math.round(opts.kwh * 1e9)) * 1_000_000_000n,
      timestamp: BigInt(Math.floor(Date.now() / 1000)),
      storageCapacity: BigInt(Math.round(opts.capacity * 1e9)) * 1_000_000_000n,
      chargeLevelPercent: Math.round(opts.soc),
      sourceType: source,
      cumulativeCycles: opts.cycles,
    };
    const signed = await edge.sign(reading);
    const dual = await cloud.cosign(signed);
    log.info('packet', {
      deviceId: dual.deviceId,
      kwh: dual.kwhAmount.toString(),
      deviceSig: dual.deviceSignature,
      vppSig: dual.vppSignature,
    });

    if (env.oracleRouterAddress.replace(/0+$/, '').length > 2) {
      const submitter = buildSubmitter(env);
      const result = await submitter.submit(dual);
      log.info('submission', result);
    } else {
      log.warn('ORACLE_ROUTER_ADDRESS not set — packet built but not submitted');
    }
  });

/* ---------------- register-device ---------------- */
program
  .command('register-device')
  .description('Call OracleRouter.registerDevice(deviceId, vpp, pubKeyHash). Owner-only on contract.')
  .requiredOption('--device <label>', 'device label (deterministic id derived from this)')
  .requiredOption('--vpp <label>', 'VPP label (deterministic VPP address derived from this)')
  .action(async (opts: { device: string; vpp: string }) => {
    const env = readEnv();
    if (!env.oracleRouterAddress.startsWith('0x')) throw new Error('ORACLE_ROUTER_ADDRESS not set');
    const deviceKey = fromSeed(opts.device);
    const vppKey = fromSeed(`vpp:${opts.vpp}`);
    const deviceId = deviceIdFromLabel(opts.device);
    log.info('registering', {
      deviceId,
      vpp: vppKey.address,
      pubKeyHash: deviceKey.pubKeyHash,
    });
    const submitter = buildSubmitter(env);
    const result = await submitter.registerDevice(deviceId, vppKey.address, deviceKey.pubKeyHash);
    log.info('registered', result);
  });

/* ---------------- helpers ---------------- */
function hashStringToInt(s: string): number {
  // FNV-1a 32-bit. Stable, fast, no crypto needed for RNG seeding.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

program.parseAsync(process.argv).catch((err: unknown) => {
  logger.error('fatal', { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
  process.exit(1);
});
