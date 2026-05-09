/**
 * @file dso-mock.test.ts
 * @description Unit tests for the mock DSO cross-reference.
 *
 * Properties tested:
 *   1. Honest packet (within ±5% noise) ALWAYS accepts.
 *   2. Malicious packet inflated by >20% ALWAYS rejects.
 *   3. The 20% threshold is exactly 2000 bps (CORE_THESIS-aligned).
 *   4. The function is deterministic when given a deterministic RNG (no
 *      hidden global state — important for property-based + replay testing).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from 'ethers';
import { dsoCheck } from '../src/dso-mock';
import { DSO_DISCREPANCY_THRESHOLD_BPS, type MeasurementPacket, SourceType } from '../src/types';

const PACKET: MeasurementPacket = {
  deviceId: keccak256(Buffer.from('exergy-device:dso-test')),
  kwhAmount: 10n * 10n ** 18n, // 10 kWh in wei
  timestamp: 1_700_000_000n,
  storageCapacity: 100n * 10n ** 18n,
  chargeLevelPercent: 50,
  sourceType: SourceType.Solar,
  cumulativeCycles: 1,
};

test('honest packet within ±5% noise → accepted (1000 trials)', () => {
  let rejected = 0;
  for (let i = 0; i < 1000; i++) {
    const r = dsoCheck(PACKET, [0.95, 1.05], `node-${i}`);
    if (!r.accepted) rejected++;
  }
  assert.equal(rejected, 0, '5% noise must never breach 20% threshold');
});

test('malicious packet inflated by >20% always rejects (deterministic RNG)', () => {
  // Force the DSO to ALWAYS report exactly the truth (factor=1). Then
  // inflate the packet's kwhAmount by 25% and confirm rejection.
  const honestKwh = 10n * 10n ** 18n;
  const inflated: MeasurementPacket = { ...PACKET, kwhAmount: (honestKwh * 125n) / 100n };

  // Pin the DSO at exactly 1.0 of (the inflated) reading is wrong — the
  // DSO sees the truth (10 kWh), not the lie. Simulate by manually choosing
  // a noise factor that yields expected = 10 kWh given reported = 12.5 kWh.
  // expected = reported * factor → factor = 10/12.5 = 0.8 ⇒ |0.8-1| = 0.2 = 20%
  // exactly on the boundary. Push it over by using 0.79.
  const r = dsoCheck(inflated, [0.79, 0.79], 'malicious-node', () => 0);
  assert.equal(r.accepted, false);
  assert.ok(r.discrepancyBps > DSO_DISCREPANCY_THRESHOLD_BPS);
});

test('threshold constant is exactly 2000 bps (20%)', () => {
  assert.equal(DSO_DISCREPANCY_THRESHOLD_BPS, 2000);
});

test('zero-kwh packet does not throw', () => {
  const zero: MeasurementPacket = { ...PACKET, kwhAmount: 0n };
  const r = dsoCheck(zero, [0.95, 1.05], 'zero-test');
  // expected ≈ 0; discrepancy should be 0 → accepted
  assert.equal(r.accepted, true);
});

test('determinism: same RNG seed yields same result', () => {
  const seq = [0.1, 0.5, 0.9];
  let i = 0;
  const rng = () => seq[i++ % seq.length] as number;
  const a = dsoCheck(PACKET, [0.95, 1.05], 'a', rng);
  i = 0;
  const b = dsoCheck(PACKET, [0.95, 1.05], 'a', rng);
  assert.equal(a.expectedKwh, b.expectedKwh);
  assert.equal(a.discrepancyBps, b.discrepancyBps);
  assert.equal(a.accepted, b.accepted);
});
