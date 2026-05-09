/**
 * @file dso-mock.ts
 * @description Mock DSO (Distribution System Operator) cross-reference.
 *
 * In production: the adapter queries the DSO's grid telemetry feed for the
 * (location, time-window) of the measurement and obtains the DSO's expected
 * energy delivered into storage during that window. If the device's reported
 * `kwhAmount` differs from the DSO's number by more than 20%, the adapter
 * REJECTS the packet — the device is either lying, the DSO is lying, or the
 * grid disagrees with the BMS. The contract refuses to mint either way.
 *
 * In Phase 0 we have no real DSO integration. This mock returns
 * `expectedKwh = packet.kwhAmount * uniform(0.95, 1.05)` per node — i.e. each
 * simulated Chainlink node sees a slightly different DSO answer (real DSO
 * APIs return slightly different snapshots from each query thanks to grid
 * ticker drift). The 5% noise is well inside the 20% threshold so honest
 * packets always pass; a malicious packet inflated by >20% always fails.
 *
 * CRITICAL — concept guardrail (CORE_THESIS §5.5):
 *   - The DSO check is autonomous. There is no admin override that can bless
 *     a packet that fails this check.
 *   - The 20% threshold is a hard-coded constant in `types.ts`. It cannot be
 *     mutated at runtime.
 *   - There is no allow-list of "trusted VPPs" whose data we accept without
 *     a DSO check. Every packet runs through this gate.
 */
import {
  DSO_DISCREPANCY_THRESHOLD_BPS,
  type DsoNodeCheck,
  type MeasurementPacket,
} from './types';

/**
 * One simulated Chainlink-node DSO check. Pure function — `randomFn` is
 * injected so tests can pin the noise to a deterministic distribution.
 *
 * @param packet      The measurement packet under review.
 * @param noiseRange  [lo, hi] multiplicative range applied to packet.kwhAmount
 *                    to produce the DSO's "expected" reading. Default
 *                    (0.95, 1.05) per the production spec.
 * @param nodeId      Stable id for the simulated node — included in the result
 *                    so logs trace which nodes accepted vs rejected.
 * @param randomFn    Returns a uniform(0, 1) sample. Injectable for tests.
 */
export function dsoCheck(
  packet: MeasurementPacket,
  noiseRange: readonly [number, number],
  nodeId: string,
  randomFn: () => number = Math.random,
): DsoNodeCheck {
  const [lo, hi] = noiseRange;
  if (lo > hi) {
    throw new Error(`dso noise range invalid: lo=${lo} > hi=${hi}`);
  }
  const reported = packet.kwhAmount;
  // Multiplicative noise: expected = reported * uniform(lo, hi).
  // We work in milli-units to keep bigint arithmetic exact (no floats on the
  // fee-relevant numerator).
  const factorMilli = BigInt(Math.round((lo + (hi - lo) * randomFn()) * 1_000_000));
  const expected = (reported * factorMilli) / 1_000_000n;

  // discrepancy = |expected - reported| / max(reported, 1) in basis points.
  // Clamp the denominator to 1 wei to avoid zero-division when a malicious
  // packet reports kwhAmount=0 (the contract would reject anyway, but the
  // adapter shouldn't crash before getting there).
  const denom = reported === 0n ? 1n : reported;
  const diff = expected >= reported ? expected - reported : reported - expected;
  const bpsBig = (diff * 10_000n) / denom;
  // Cap at uint32 for JSON ergonomics; anything above 100% is "huge" anyway.
  const discrepancyBps = Number(bpsBig > 1_000_000n ? 1_000_000n : bpsBig);

  const accepted = discrepancyBps <= DSO_DISCREPANCY_THRESHOLD_BPS;

  return {
    nodeId,
    expectedKwh: expected,
    reportedKwh: reported,
    discrepancyBps,
    accepted,
  };
}
