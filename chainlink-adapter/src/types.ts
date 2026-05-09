/**
 * @file types.ts
 * @description Shared types for the Chainlink External Adapter.
 *
 * `MeasurementPacket` mirrors the on-chain struct defined in
 * `contracts/interfaces/IOracleRouter.sol` and the off-chain shape used by
 * `oracle-simulator/src/types.ts`. Field order, sizes, and ABI types MUST
 * match byte-for-byte — the adapter recomputes the same `keccak256(abi.encode(...))`
 * digest the contract recovers from. See `docs/PROTOCOL_SPEC.md` for the
 * canonical EXERGY_SIGNATURE_DIALECT_V0.
 */

/** uint8 source-type discriminator. STABLE — do not renumber. */
export enum SourceType {
  Solar = 0,
  Wind = 1,
  Hydro = 2,
  Other = 3,
}

/**
 * The off-chain payload signed by the device. All numeric fields use bigint
 * where the on-chain type is uint256/uint64/uint32 to keep precision when the
 * packet round-trips through ABI encoding.
 */
export interface MeasurementPacket {
  /** bytes32 stable identifier of the physical device. */
  readonly deviceId: string;
  /** uint256 — kWh delivered into storage during this measurement window
   *  (18-decimal wei scaling on chain; bigint here). */
  readonly kwhAmount: bigint;
  /** uint64 unix seconds when the BMS captured the reading. */
  readonly timestamp: bigint;
  /** uint256 — nameplate storage capacity (18-decimal wei). */
  readonly storageCapacity: bigint;
  /** uint8 — 0..100, battery state-of-charge at sample time. */
  readonly chargeLevelPercent: number;
  /** uint8 — see SourceType. */
  readonly sourceType: SourceType;
  /** uint32 — Proof-of-Wear: cumulative full-equivalent cycles to date. */
  readonly cumulativeCycles: number;
}

/**
 * Wire payload accepted by `POST /submit`. Same shape as oracle-simulator's
 * DualSignedPacket but with bigints serialized as decimal strings (JSON
 * doesn't carry bigint natively).
 */
export interface SubmitRequest {
  readonly packet: {
    readonly deviceId: string;
    readonly kwhAmount: string;          // decimal string, parses to bigint
    readonly timestamp: string;          // decimal string, parses to bigint
    readonly storageCapacity: string;    // decimal string, parses to bigint
    readonly chargeLevelPercent: number;
    readonly sourceType: number;
    readonly cumulativeCycles: number;
  };
  readonly deviceSignature: string;       // 0x-prefixed 65-byte hex
  readonly vppSignature: string;          // 0x-prefixed 65-byte hex
  /** Optional client-side correlation id for log-grepping. */
  readonly requestId?: string;
}

/** Final response shape from `POST /submit`. */
export interface SubmitResponse {
  readonly ok: boolean;
  readonly txHash?: string;
  readonly blockNumber?: number;
  readonly reason?: string;
  readonly stage?: 'verify' | 'consensus' | 'relay';
  readonly consensus?: ConsensusSummary;
  readonly requestId?: string;
}

/** Off-chain dual-signature recovery result. */
export interface ValidationResult {
  readonly ok: boolean;
  /** Recovered device address (0x...). Lower-case. */
  readonly deviceAddress?: string;
  /** keccak256 of recovered device address — what the contract stores. */
  readonly devicePubKeyHash?: string;
  /** Recovered VPP cloud cosigner address. Lower-case. */
  readonly vppAddress?: string;
  /** packetHash (keccak256 of abi.encode(packet)). */
  readonly packetHash?: string;
  /** Reason if !ok. */
  readonly reason?: string;
}

/** Single simulated Chainlink-node DSO check outcome. */
export interface DsoNodeCheck {
  readonly nodeId: string;
  /** Mock expected kWh from the DSO grid model (with per-node noise). */
  readonly expectedKwh: bigint;
  /** Reported kWh from the packet. */
  readonly reportedKwh: bigint;
  /** abs(expected - reported) / max(reported, 1) — bps (10000 = 100%). */
  readonly discrepancyBps: number;
  /** True iff discrepancyBps <= 2000 (20% threshold). */
  readonly accepted: boolean;
}

/** Output of the consensus stage (3-of-5). */
export interface ConsensusResult {
  readonly accepted: boolean;
  readonly acceptCount: number;
  readonly rejectCount: number;
  readonly nodes: readonly DsoNodeCheck[];
  readonly reason?: string;
}

/** Compact consensus summary safe to ship in JSON responses. */
export interface ConsensusSummary {
  readonly accepted: boolean;
  readonly acceptCount: number;
  readonly rejectCount: number;
  readonly threshold: number;
  readonly maxDiscrepancyBps: number;
}

/** Adapter configuration loaded from env + CLI flags. */
export interface AdapterConfig {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly oracleRouterAddress: string;
  readonly relayerPrivateKey: string;
  readonly port: number;
  readonly host: string;
  readonly dryRun: boolean;
  readonly maxRetries: number;
  readonly retryBackoffMs: number;
  readonly dsoNoiseRange: readonly [number, number];
}

/** Constants — DO NOT make these mutable at runtime. CORE_THESIS §5.5: no
 *  human reviews, no admin overrides. */
export const CONSENSUS_NODE_COUNT = 5 as const;
export const CONSENSUS_THRESHOLD = 3 as const;
/** Discrepancy threshold in basis points (10000 = 100%). 2000 bps = 20%. */
export const DSO_DISCREPANCY_THRESHOLD_BPS = 2000 as const;

/** Adapter dialect tag — bumps when the wire format changes. */
export const ADAPTER_DIALECT = 'EXERGY_CHAINLINK_ADAPTER_V1' as const;
