/**
 * @file battery-sim.ts
 * @description Realistic battery simulator. NOT random noise.
 *
 * Profiles:
 *  - Solar: bell curve peaking at solar noon (12:00 local), zero before sunrise
 *    and after sunset. Sunrise/sunset shift with latitude (very rough cosine
 *    daylight fraction). Cloud cover modeled as a slow random walk multiplier.
 *  - Wind: autocorrelated noise (AR(1)) bounded to [0, chargeRate]. Nights and
 *    days look similar — wind doesn't care about the sun.
 *  - Hydro: nearly constant baseline with small drift. Dispatchable.
 *  - Other: small constant trickle (placeholder).
 *
 * State of charge tracks integration of (charge - discharge). When SoC hits
 * 100% the battery synthetically discharges to support a household / grid
 * load and a full charge-discharge cycle increments cumulativeCycles. Cycle
 * counter is rounded down — partial cycles do not increment.
 *
 * Anomaly hooks: the simulator can be poked into reporting impossible energy
 * (kwh > capacity * (cycles + 1)) for testing the contract's rejection path.
 * Triggered via constructor flag `attackerMode`.
 */
import { type BatterySimConfig, type BmsReading, type SimulatorTickResult, AnomalyCode, SourceType, type Anomaly } from './types';
import { child } from './logger';

const log = child('battery-sim');

/** Convert kWh to 18-decimal fixed-point bigint. */
function toWadKwh(kwh: number): bigint {
  // Multiply by 1e18, round to nearest integer to avoid float drift.
  const scaled = Math.round(kwh * 1e9); // 9 decimals first
  return BigInt(scaled) * 1_000_000_000n; // up to 18 decimals
}

/** Mulberry32 — small fast deterministic PRNG. Same seed = same sequence. */
function makeRng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hours since local midnight from a unix-second timestamp + tz offset. */
function localHourOfDay(unixSec: number, tzOffsetHours: number): number {
  const localSec = unixSec + tzOffsetHours * 3600;
  const dayFraction = ((localSec % 86_400) + 86_400) % 86_400;
  return dayFraction / 3600;
}

/** Daylight fraction at given latitude on day-of-year. Rough but smooth. */
function daylightHours(latDeg: number, dayOfYear: number): number {
  const latRad = (latDeg * Math.PI) / 180;
  // Solar declination — Cooper's approximation.
  const decl = 23.44 * Math.sin(((2 * Math.PI) / 365) * (dayOfYear - 81));
  const declRad = (decl * Math.PI) / 180;
  const cosH = -Math.tan(latRad) * Math.tan(declRad);
  // Clamp polar day / polar night.
  const clamped = Math.max(-1, Math.min(1, cosH));
  const hourAngle = Math.acos(clamped);
  return (2 * (hourAngle * 180)) / Math.PI / 15;
}

/**
 * Solar power factor at a given local hour, latitude, day-of-year, and a slow
 * cloud multiplier in [0, 1]. Returns kW fraction in [0, 1].
 */
function solarPowerFactor(localHour: number, latDeg: number, dayOfYear: number, cloud: number): number {
  const dayLen = daylightHours(latDeg, dayOfYear);
  if (dayLen <= 0) return 0;
  const sunrise = 12 - dayLen / 2;
  const sunset = 12 + dayLen / 2;
  if (localHour <= sunrise || localHour >= sunset) return 0;
  // Half-cosine bell, peak at noon.
  const phase = ((localHour - sunrise) / dayLen) * Math.PI;
  const bell = Math.sin(phase);
  return Math.max(0, bell * cloud);
}

/**
 * Battery simulator. One instance per device. `tick(durationHours)` advances
 * the internal clock and returns the BMS reading + any anomalies.
 */
export class BatterySim {
  private soc: number;
  private cycles: number;
  /** Accumulator of discharge progress within the current cycle (kWh). */
  private cycleAccumKwh = 0;
  private nowUnixSec: bigint;
  private cloud: number;
  private windState: number;
  private readonly rng: () => number;
  private readonly cfg: Required<BatterySimConfig>;
  private readonly attackerMode: boolean;

  constructor(cfg: BatterySimConfig, opts: { startUnixSec?: bigint; attackerMode?: boolean } = {}) {
    if (cfg.capacityKwh <= 0) throw new Error(`capacityKwh must be > 0, got ${cfg.capacityKwh}`);
    if (cfg.chargeRateKw <= 0) throw new Error(`chargeRateKw must be > 0`);
    if (cfg.dischargeRateKw <= 0) throw new Error(`dischargeRateKw must be > 0`);
    if (cfg.initialSocPercent < 0 || cfg.initialSocPercent > 100) {
      throw new Error(`initialSocPercent out of [0,100]`);
    }

    this.cfg = {
      latitudeDeg: 35, // mid-latitude default
      timezoneOffsetHours: 0,
      seed: 0x1a2b3c4d,
      ...cfg,
    };
    this.soc = cfg.initialSocPercent;
    this.cycles = cfg.initialCycles;
    this.nowUnixSec = opts.startUnixSec ?? BigInt(Math.floor(Date.now() / 1000));
    this.attackerMode = opts.attackerMode ?? false;
    this.rng = makeRng(this.cfg.seed);
    this.cloud = 0.85; // start with a mostly-clear day
    this.windState = 0.5;
  }

  /** Current internal clock (unix seconds). */
  get now(): bigint {
    return this.nowUnixSec;
  }

  /** Advance the simulator by `durationHours` and return one BMS reading. */
  tick(durationHours: number): SimulatorTickResult {
    if (durationHours <= 0) throw new Error(`durationHours must be > 0`);

    // Slow walks for cloud cover and wind state.
    this.cloud = clamp01(this.cloud + (this.rng() - 0.5) * 0.15);
    // AR(1): w_t = 0.85*w_{t-1} + 0.15*noise
    this.windState = clamp01(0.85 * this.windState + 0.15 * this.rng());

    const localHour = localHourOfDay(Number(this.nowUnixSec), this.cfg.timezoneOffsetHours);
    const dayOfYear = Math.floor((Number(this.nowUnixSec) / 86_400) % 365) + 1;

    // Compute incoming generation factor based on source.
    let genFactor: number;
    switch (this.cfg.source) {
      case SourceType.Solar:
        genFactor = solarPowerFactor(localHour, this.cfg.latitudeDeg, dayOfYear, this.cloud);
        break;
      case SourceType.Wind:
        genFactor = this.windState;
        break;
      case SourceType.Hydro:
        // Hydro: dispatchable, near-constant ~70%.
        genFactor = 0.7 + (this.rng() - 0.5) * 0.05;
        break;
      case SourceType.Other:
        genFactor = 0.2; // small trickle
        break;
      default: {
        const exhaustive: never = this.cfg.source;
        throw new Error(`Unknown source: ${String(exhaustive)}`);
      }
    }
    genFactor = clamp01(genFactor);

    // Demand profile: morning + evening peaks (typical residential). Used to
    // discharge the battery so cycles actually accumulate during simulated days.
    const demandFactor = householdDemandFactor(localHour);

    const inflowKwh = this.cfg.chargeRateKw * genFactor * durationHours;
    const outflowKwh = this.cfg.dischargeRateKw * demandFactor * durationHours;

    // Net change to SoC (in kWh first, then percent).
    const headroomKwh = ((100 - this.soc) / 100) * this.cfg.capacityKwh;
    const flooredOutflowKwh = Math.min(outflowKwh, ((this.soc / 100) * this.cfg.capacityKwh));
    const acceptedInflowKwh = Math.min(inflowKwh, headroomKwh + flooredOutflowKwh);
    const netKwh = acceptedInflowKwh - flooredOutflowKwh;
    const newSoc = clamp(0, 100, this.soc + (netKwh / this.cfg.capacityKwh) * 100);

    // Cycle accounting: count throughput against capacity. One full cycle =
    // capacityKwh of cumulative discharge. We accumulate flooredOutflowKwh and
    // floor-divide.
    this.cycleAccumKwh += flooredOutflowKwh;
    const cyclesAdded = Math.floor(this.cycleAccumKwh / this.cfg.capacityKwh);
    if (cyclesAdded > 0) {
      this.cycles += cyclesAdded;
      this.cycleAccumKwh -= cyclesAdded * this.cfg.capacityKwh;
    }

    this.soc = newSoc;
    this.nowUnixSec += BigInt(Math.round(durationHours * 3600));

    // Build the on-the-wire BMS reading. kwhAmount is the *charged* (positive
    // inflow) energy in this window — that is what the protocol mints against.
    let reportedKwh = acceptedInflowKwh;

    const anomalies: Anomaly[] = [];
    if (this.attackerMode) {
      // Attacker reports 10x the physical truth — should be rejected on-chain
      // by Proof-of-Wear sanity checks.
      reportedKwh = acceptedInflowKwh * 10 + this.cfg.capacityKwh * (this.cycles + 1);
      anomalies.push({
        code: AnomalyCode.ImpossibleEnergy,
        message: `attackerMode=true: reportedKwh=${reportedKwh.toFixed(2)} exceeds capacity*cycles ceiling`,
      });
    }
    if (newSoc < 0 || newSoc > 100) {
      anomalies.push({ code: AnomalyCode.InvalidSoc, message: `soc=${newSoc}` });
    }

    const reading: BmsReading = {
      deviceId: this.cfg.deviceId,
      kwhAmount: toWadKwh(reportedKwh),
      timestamp: this.nowUnixSec,
      storageCapacity: toWadKwh(this.cfg.capacityKwh),
      chargeLevelPercent: Math.round(newSoc),
      sourceType: this.cfg.source,
      cumulativeCycles: this.cycles,
    };

    if (anomalies.length > 0) {
      log.warn('anomalies', { deviceId: reading.deviceId, anomalies });
    } else {
      log.debug('tick', {
        deviceId: reading.deviceId,
        localHour: Math.round(localHour * 100) / 100,
        soc: Math.round(newSoc),
        kwh: Math.round(reportedKwh * 1000) / 1000,
        cycles: this.cycles,
      });
    }

    return { reading, anomalies };
  }
}

/* ---------------- helpers ---------------- */

function clamp(min: number, max: number, x: number): number {
  return Math.max(min, Math.min(max, x));
}
function clamp01(x: number): number {
  return clamp(0, 1, x);
}

/** Synthetic residential demand: morning peak ~7-9, evening peak ~18-22. */
function householdDemandFactor(localHour: number): number {
  const morning = bumpAt(localHour, 8, 1.5);
  const evening = bumpAt(localHour, 20, 2.0);
  return clamp01(0.1 + 0.4 * morning + 0.5 * evening);
}

/** Gaussian-ish bump centered at `mu` with width `sigma` hours. */
function bumpAt(x: number, mu: number, sigma: number): number {
  const z = (x - mu) / sigma;
  return Math.exp(-0.5 * z * z);
}
