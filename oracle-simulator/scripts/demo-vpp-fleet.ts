#!/usr/bin/env ts-node
/**
 * @file demo-vpp-fleet.ts
 * @description Three-region VPP fleet demo.
 *
 * Spins up:
 *  - vpp-tx   — Texas-style high-solar fleet (8 devices, lat=31, tz=-6)
 *  - vpp-be   — Berlin-style mixed solar+wind (10 devices, lat=52, tz=+1)
 *  - vpp-au   — Sydney-style high-solar (5 devices, lat=-33, tz=+10)
 *
 * Runs 24 hours of simulated time at 2 packets/hour/device, dual-signs each
 * packet, and (if ORACLE_ROUTER_ADDRESS is set) submits on-chain. By default
 * runs in offline mode — set DRY_RUN=0 + ORACLE_ROUTER_ADDRESS to actually
 * push transactions to Arbitrum Sepolia.
 *
 * Useful for: end-to-end smoke test before integration with the smart-contracts
 * agent's deployed router. Output is the structured log; pipe through grep
 * to filter component=submitter for tx hashes.
 */
import 'dotenv/config';
import { BatterySim } from '../src/battery-sim';
import { EdgeDevice } from '../src/edge-device';
import { VppCloud, DeviceRegistry } from '../src/vpp-cloud';
import { Submitter } from '../src/submitter';
import { deviceFleet, fromSeed } from '../src/keypair';
import { SourceType } from '../src/types';
import { child, logger } from '../src/logger';

const log = child('demo-fleet');

interface VppSpec {
  readonly label: string;
  readonly devices: number;
  readonly source: SourceType;
  readonly latitude: number;
  readonly tz: number;
  readonly capacityKwh: number;
  readonly chargeRateKw: number;
  readonly dischargeRateKw: number;
}

const SPECS: readonly VppSpec[] = [
  { label: 'vpp-tx', devices: 8,  source: SourceType.Solar, latitude:  31, tz: -6, capacityKwh: 13.5, chargeRateKw: 5,   dischargeRateKw: 5   },
  { label: 'vpp-be', devices: 10, source: SourceType.Wind,  latitude:  52, tz:  1, capacityKwh: 27.0, chargeRateKw: 7,   dischargeRateKw: 7   },
  { label: 'vpp-au', devices: 5,  source: SourceType.Solar, latitude: -33, tz: 10, capacityKwh: 100,  chargeRateKw: 25,  dischargeRateKw: 25  },
];

const SIM_HOURS = Number(process.env.DEMO_HOURS ?? 24);
const PACKETS_PER_HOUR = Number(process.env.DEMO_RATE ?? 2);
const TICK_HOURS = 1 / PACKETS_PER_HOUR;

interface Runner {
  readonly vppLabel: string;
  readonly cloud: VppCloud;
  readonly devices: ReadonlyArray<{
    readonly label: string;
    readonly device: EdgeDevice;
    readonly sim: BatterySim;
  }>;
}

async function buildRunner(spec: VppSpec, attackerLabel: string | null): Promise<Runner> {
  const vppKey = fromSeed(`vpp:${spec.label}`);
  const fleet = deviceFleet(spec.label, spec.devices);
  const registry = new DeviceRegistry();
  for (const d of fleet) registry.register(d.deviceId, d.keypair.address);

  const startUnix = BigInt(Math.floor(Date.now() / 1000));
  const devices = fleet.map((d) => ({
    label: d.label,
    device: new EdgeDevice(d.keypair),
    sim: new BatterySim(
      {
        deviceId: d.deviceId,
        capacityKwh: spec.capacityKwh,
        chargeRateKw: spec.chargeRateKw,
        dischargeRateKw: spec.dischargeRateKw,
        source: spec.source,
        initialSocPercent: 25 + Math.floor(Math.random() * 30),
        initialCycles: 0,
        latitudeDeg: spec.latitude,
        timezoneOffsetHours: spec.tz,
        seed: hashStringToInt(d.label),
      },
      {
        startUnixSec: startUnix,
        attackerMode: attackerLabel !== null && d.label === attackerLabel,
      },
    ),
  }));

  log.info('runner ready', {
    vpp: spec.label,
    address: vppKey.address,
    devices: devices.length,
  });
  return { vppLabel: spec.label, cloud: new VppCloud(vppKey, registry), devices };
}

async function main(): Promise<void> {
  const oracleAddr = process.env.ORACLE_ROUTER_ADDRESS ?? '';
  const submitter = oracleAddr.startsWith('0x') && oracleAddr.replace(/0+$/, '').length > 2
    ? new Submitter({
      rpcUrl: process.env.ARBITRUM_SEPOLIA_RPC_URL ?? '',
      oracleRouterAddress: oracleAddr,
      submitterPrivateKey: process.env.SUBMITTER_PRIVATE_KEY ?? '',
      dryRun: process.env.DRY_RUN === '1',
      maxRetries: Number(process.env.SUBMIT_MAX_RETRIES ?? 3),
      retryBackoffMs: Number(process.env.SUBMIT_RETRY_BACKOFF_MS ?? 1500),
    })
    : null;
  if (!submitter) log.warn('offline mode — packets will be built and signed but not submitted');

  // Pick the first device in vpp-tx as the attacker for testing rejection paths.
  const runners = await Promise.all(SPECS.map((s, i) => buildRunner(s, i === 0 ? `${s.label}:device-000` : null)));

  const ticks = Math.ceil(SIM_HOURS / TICK_HOURS);
  log.info('demo start', { ticks, simHours: SIM_HOURS, packetsPerHour: PACKETS_PER_HOUR });

  let totalAccepted = 0;
  let totalRejected = 0;
  let totalSubmitted = 0;
  let totalSubmitErrors = 0;

  for (let t = 0; t < ticks; t++) {
    for (const r of runners) {
      const signed = await Promise.all(r.devices.map(async (d) => {
        const { reading, anomalies } = d.sim.tick(TICK_HOURS);
        if (anomalies.length > 0) {
          log.warn('anomaly', { vpp: r.vppLabel, device: d.label, anomalies });
        }
        return d.device.sign(reading);
      }));
      const cosign = await r.cloud.cosignBatch(signed);
      totalAccepted += cosign.accepted.length;
      totalRejected += cosign.rejected.length;

      if (submitter) {
        for (const p of cosign.accepted) {
          const result = await submitter.submit(p);
          if (result.ok) totalSubmitted++;
          else totalSubmitErrors++;
        }
      }
    }

    if ((t + 1) % 5 === 0 || t === ticks - 1) {
      log.info('progress', {
        tick: t + 1,
        ticks,
        accepted: totalAccepted,
        rejected: totalRejected,
        submitted: totalSubmitted,
        submitErrors: totalSubmitErrors,
      });
    }
  }

  log.info('demo done', {
    accepted: totalAccepted,
    rejected: totalRejected,
    submitted: totalSubmitted,
    submitErrors: totalSubmitErrors,
  });
}

function hashStringToInt(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

main().catch((err: unknown) => {
  logger.error('demo failed', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
