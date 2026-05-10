import { AbiCoder, keccak256, parseUnits } from "ethers";

/**
 * The exact MeasurementPacket struct defined in IOracleRouter.sol.
 *
 * Field order, types, and decimal semantics MUST match the on-chain struct
 * byte-for-byte — `abi.encode` of this object is what gets signed and
 * recovered by the contract. Any deviation breaks signature verification.
 *
 * - `kwhAmount` and `storageCapacity` are 18-decimal fixed-point bigints
 *   (1 kWh = 10n ** 18n). Use `kwhToWad(...)` to convert from human kWh.
 * - `timestamp` is unix seconds. Must be within the contract's accepted
 *   window: `block.timestamp - 72h <= timestamp <= block.timestamp + 5min`.
 * - `cumulativeCycles` is the device's lifetime monotonic cycle counter.
 *   Within any epoch, `cumulativeCycles` may increment by at most
 *   `2 * (epochsDelta + 1)` — the protocol's Proof-of-Wear budget.
 */
export interface MeasurementPacket {
  deviceId: string; // bytes32, 0x-prefixed hex
  kwhAmount: bigint; // uint256, 18-decimal fixed point
  timestamp: bigint; // uint64, unix seconds
  storageCapacity: bigint; // uint256, 18-decimal fixed point
  chargeLevelPercent: number; // uint8, 0–100
  sourceType: SourceType; // uint8, see enum below
  cumulativeCycles: number; // uint32
}

export enum SourceType {
  Solar = 0,
  Wind = 1,
  Hydro = 2,
  Other = 3,
}

/**
 * Canonical ABI tuple for `abi.encode(MeasurementPacket)`. Field order
 * matches IOracleRouter.sol.
 */
export const PACKET_TUPLE =
  "tuple(" +
  "bytes32 deviceId," +
  "uint256 kwhAmount," +
  "uint64 timestamp," +
  "uint256 storageCapacity," +
  "uint8 chargeLevelPercent," +
  "uint8 sourceType," +
  "uint32 cumulativeCycles" +
  ")";

/**
 * Compute the canonical packet hash that gets signed by both the device
 * and the VPP cloud key. Mirrors `keccak256(abi.encode(packet))` in
 * `OracleRouter.submitMeasurement`.
 */
export function buildPacketHash(packet: MeasurementPacket): string {
  const encoded = AbiCoder.defaultAbiCoder().encode(
    [PACKET_TUPLE],
    [
      [
        packet.deviceId,
        packet.kwhAmount,
        packet.timestamp,
        packet.storageCapacity,
        packet.chargeLevelPercent,
        packet.sourceType,
        packet.cumulativeCycles,
      ],
    ],
  );
  return keccak256(encoded);
}

/**
 * Convert a human-readable kWh value to the 18-decimal fixed-point bigint
 * the contract expects. Uses a two-stage multiply to preserve precision
 * past what `Number * 1e18` can represent.
 *
 * Example: `kwhToWad(5.2)` → `5_200_000_000_000_000_000n`.
 */
export function kwhToWad(kwh: number): bigint {
  // Two-stage multiplication preserves more precision than (kwh * 1e18).
  return BigInt(Math.round(kwh * 1e9)) * 1_000_000_000n;
}

/**
 * Convenience wrapper around `parseUnits` for the same purpose, when you
 * have a string representation of kWh (e.g. from a database column with
 * arbitrary precision).
 */
export function kwhToWadFromString(kwh: string): bigint {
  return parseUnits(kwh, 18);
}
