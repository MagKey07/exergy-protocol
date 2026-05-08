/**
 * @file types.ts
 * @description Shared type definitions for the Exergy oracle simulator.
 *
 * Mirrors the on-chain MeasurementPacket struct that OracleRouter.sol expects.
 * Keep field order, sizes, and ABI types in sync with the Solidity contract —
 * the device hash is computed via abi.encode() and must match byte-for-byte.
 *
 * Reference: Technical_Blueprint.md §3 "Measurement Packet (from device)".
 */

/**
 * Energy source classification. Encoded as uint8 on-chain.
 * Values are stable; do NOT renumber without coordinating with the contract.
 */
export enum SourceType {
  Solar = 0,
  Wind = 1,
  Hydro = 2,
  Other = 3,
}

/**
 * The raw telemetry reading produced by the (mock) battery BMS, *before* any
 * cryptographic signing happens. The edge device will hash + sign these fields.
 *
 * All numeric fields use bigint where the on-chain type is uint256/uint64/uint32
 * to keep precision and avoid silent rounding when packet roundtrips through
 * ABI encoding.
 */
export interface BmsReading {
  /** bytes32 stable identifier of the physical device. */
  readonly deviceId: string;
  /** uint256, 18 decimals — kWh delta charged into storage during this measurement window. */
  readonly kwhAmount: bigint;
  /** uint64 unix seconds when the BMS captured the reading. */
  readonly timestamp: bigint;
  /** uint256, 18 decimals — nameplate storage capacity of the battery. */
  readonly storageCapacity: bigint;
  /** uint8 — 0..100, battery state-of-charge at sample time. */
  readonly chargeLevelPercent: number;
  /** uint8 — see SourceType. */
  readonly sourceType: SourceType;
  /** uint32 — Proof-of-Wear: cumulative full-equivalent cycles to date. */
  readonly cumulativeCycles: number;
}

/**
 * Packet after the edge device (Pi + HSM) has signed the BMS reading.
 *
 * `deviceSignature` is a 65-byte ECDSA secp256k1 signature (r || s || v),
 * 0x-prefixed hex. It signs the keccak256 of the canonical ABI encoding of
 * the BMS fields — see edge-device.ts::buildDeviceDigest.
 */
export interface SignedDevicePacket extends BmsReading {
  /** 0x-prefixed 65-byte ECDSA signature from the device's HSM key. */
  readonly deviceSignature: string;
}

/**
 * Final packet after the VPP cloud has co-signed. This is what we push
 * on-chain to OracleRouter.submitMeasurement(...).
 *
 * Dual signature (device + VPP cloud) is the protocol's Anti-Simulation Lock:
 * a single signature is rejected at the contract level.
 */
export interface DualSignedPacket extends SignedDevicePacket {
  /** bytes32 hash of the device portion that VPP signs over (with deviceSignature included). */
  readonly vppDigest: string;
  /** Address of the VPP cloud signer (must match the registered VPP for deviceId). */
  readonly vppAddress: string;
  /** 0x-prefixed 65-byte ECDSA signature from the VPP cloud's signing key. */
  readonly vppSignature: string;
}

/**
 * Convenience alias used by the on-chain submitter. The submitter does not
 * differentiate beyond "fully signed" — both signatures are required.
 */
export type MeasurementPacket = DualSignedPacket;

/**
 * Result from a single submission attempt. We keep submitter logic simple:
 * either we got a tx hash, or we got an error message. The caller logs.
 */
export interface SubmissionResult {
  readonly ok: boolean;
  readonly txHash?: string;
  readonly blockNumber?: number;
  readonly error?: string;
  /** Number of attempts made (1 = first try succeeded). */
  readonly attempts: number;
}

/**
 * Battery simulator config. Keep values realistic: a residential Powerwall is
 * ~13.5 kWh @ 5 kW; a Megapack is ~3.9 MWh @ ~1.9 MW. The simulator does not
 * enforce manufacturer-specific limits; that's an investor-facing concern.
 */
export interface BatterySimConfig {
  readonly deviceId: string;
  /** kWh nameplate. */
  readonly capacityKwh: number;
  /** kW peak charge rate. */
  readonly chargeRateKw: number;
  /** Discharge rate kW (used in the synthetic discharge half-cycle). */
  readonly dischargeRateKw: number;
  readonly source: SourceType;
  /** Initial state-of-charge in percent (0..100). */
  readonly initialSocPercent: number;
  /** Initial cumulative cycles (Proof-of-Wear). */
  readonly initialCycles: number;
  /**
   * Geographic latitude for solar profile shaping. Defaults pick reasonable
   * mid-latitude curves. Wind/hydro/other are insensitive to latitude.
   */
  readonly latitudeDeg?: number;
  /**
   * Time-of-day offset for the simulator's "wall clock". Lets the same
   * underlying clock represent Texas vs Berlin vs Sydney. Hours.
   */
  readonly timezoneOffsetHours?: number;
  /**
   * Random seed for stochastic sources (wind). Same seed = reproducible run.
   */
  readonly seed?: number;
}

/**
 * Simulator tick output. Caller decides what to do with anomalies — typically
 * log + still submit so contract-level rejection paths can be tested.
 */
export interface SimulatorTickResult {
  readonly reading: BmsReading;
  /**
   * Anomalies detected by sanity checks inside the simulator (e.g. an
   * attacker's mock device reporting more kWh than physically possible).
   * Empty array = clean reading.
   */
  readonly anomalies: readonly Anomaly[];
}

export interface Anomaly {
  readonly code: AnomalyCode;
  readonly message: string;
}

export enum AnomalyCode {
  /** kwhAmount exceeds capacity * (cycles + 1) — physically impossible. */
  ImpossibleEnergy = 'IMPOSSIBLE_ENERGY',
  /** chargeLevelPercent stepped outside 0..100. */
  InvalidSoc = 'INVALID_SOC',
  /** Cycle counter went backwards. */
  CycleRegression = 'CYCLE_REGRESSION',
}
