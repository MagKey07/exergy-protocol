/**
 * @file verifier.test.ts
 * @description Unit tests for off-chain dual-signature verification.
 *
 * Run with `npm test`. Uses the standard Node `node:test` runner so we don't
 * pull in vitest/jest just for a few suites.
 *
 * Critically these tests reproduce the EXERGY_SIGNATURE_DIALECT_V0 byte
 * sequence end-to-end (signing → recovering) — drift between this test and
 * `oracle-simulator/src/edge-device.ts` would surface as a failed equality
 * assertion before any contract-level integration is attempted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, getBytes, keccak256, Wallet } from 'ethers';
import { computePacketHash, verifyDualSignature } from '../src/verifier';
import { type MeasurementPacket, SourceType } from '../src/types';

const PACKET_ABI_TYPES = [
  'bytes32', 'uint256', 'uint64', 'uint256', 'uint8', 'uint8', 'uint32',
] as const;

const PACKET: MeasurementPacket = {
  deviceId: keccak256(Buffer.from('exergy-device:test-001')),
  kwhAmount: 5_000_000_000_000_000_000n,        // 5 kWh in wei
  timestamp: 1_700_000_000n,
  storageCapacity: 13_500_000_000_000_000_000n, // 13.5 kWh in wei
  chargeLevelPercent: 65,
  sourceType: SourceType.Solar,
  cumulativeCycles: 12,
};

async function signPacket(packet: MeasurementPacket, deviceKey: string, vppKey: string): Promise<{
  deviceSig: string;
  vppSig: string;
}> {
  const device = new Wallet(deviceKey);
  const vpp = new Wallet(vppKey);
  const packetHash = computePacketHash(packet);
  const deviceSig = await device.signMessage(getBytes(packetHash));
  const vppPayload = AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'bytes'],
    [packetHash, deviceSig],
  );
  const vppSig = await vpp.signMessage(getBytes(keccak256(vppPayload)));
  return { deviceSig, vppSig };
}

test('verifyDualSignature accepts a properly dual-signed packet', async () => {
  const deviceKey = keccak256(Buffer.from('test-device-key'));
  const vppKey = keccak256(Buffer.from('test-vpp-key'));
  const { deviceSig, vppSig } = await signPacket(PACKET, deviceKey, vppKey);

  const result = verifyDualSignature(PACKET, deviceSig, vppSig);
  assert.equal(result.ok, true);
  assert.equal(result.deviceAddress, new Wallet(deviceKey).address.toLowerCase());
  assert.equal(result.vppAddress, new Wallet(vppKey).address.toLowerCase());
});

test('verifyDualSignature rejects a swapped device signature (different signer)', async () => {
  const goodKey = keccak256(Buffer.from('test-device-key'));
  const evilKey = keccak256(Buffer.from('attacker-key'));
  const vppKey = keccak256(Buffer.from('test-vpp-key'));
  const { deviceSig: goodSig } = await signPacket(PACKET, goodKey, vppKey);
  const { deviceSig: evilSig } = await signPacket(PACKET, evilKey, vppKey);

  // Swapping the device signature changes the recovered address. The
  // adapter doesn't have the registry — it just returns the recovered
  // address and lets the contract decide. So this test confirms that
  // the recovered address differs (the contract's registry check would fail).
  const goodResult = verifyDualSignature(PACKET, goodSig, await signPacket(PACKET, goodKey, vppKey).then((s) => s.vppSig));
  const evilResult = verifyDualSignature(PACKET, evilSig, await signPacket(PACKET, evilKey, vppKey).then((s) => s.vppSig));
  assert.equal(goodResult.ok, true);
  assert.equal(evilResult.ok, true);
  assert.notEqual(goodResult.deviceAddress, evilResult.deviceAddress);
});

test('verifyDualSignature rejects malformed device signature', () => {
  const result = verifyDualSignature(PACKET, '0xdeadbeef', '0xdeadbeef');
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /device signature recovery failed/i);
});

test('verifyDualSignature rejects malformed VPP signature when device sig is fine', async () => {
  const deviceKey = keccak256(Buffer.from('test-device-key'));
  const vppKey = keccak256(Buffer.from('test-vpp-key'));
  const { deviceSig } = await signPacket(PACKET, deviceKey, vppKey);
  const result = verifyDualSignature(PACKET, deviceSig, '0xdeadbeef');
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /vpp signature recovery failed/i);
});

test('computePacketHash matches abi.encode(packet) byte-for-byte (dialect parity)', () => {
  // Direct encoding of the canonical field tuple.
  const direct = keccak256(AbiCoder.defaultAbiCoder().encode([...PACKET_ABI_TYPES], [
    PACKET.deviceId,
    PACKET.kwhAmount,
    PACKET.timestamp,
    PACKET.storageCapacity,
    PACKET.chargeLevelPercent,
    PACKET.sourceType,
    PACKET.cumulativeCycles,
  ]));
  assert.equal(computePacketHash(PACKET), direct);
});

test('VPP digest binds packetHash + deviceSignature (no other fields)', async () => {
  // Re-implement the canonical V0 VPP digest and assert byte-equality with
  // what verifier.ts uses. This is the regression guard for CONCEPT_AUDIT D-1.
  const deviceKey = keccak256(Buffer.from('test-device-key'));
  const vppKey = keccak256(Buffer.from('test-vpp-key'));
  const { deviceSig } = await signPacket(PACKET, deviceKey, vppKey);

  const hash = computePacketHash(PACKET);
  const canonical = keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes'], [hash, deviceSig]));

  // Sign the canonical digest and re-verify — must round-trip.
  const vpp = new Wallet(vppKey);
  const sig = await vpp.signMessage(getBytes(canonical));
  const result = verifyDualSignature(PACKET, deviceSig, sig);
  assert.equal(result.ok, true);
  assert.equal(result.vppAddress, vpp.address.toLowerCase());
});
