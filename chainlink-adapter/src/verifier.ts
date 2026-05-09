/**
 * @file verifier.ts
 * @description Off-chain dual-signature verifier — defence-in-depth.
 *
 * The on-chain OracleRouter ALSO performs this verification (see
 * `contracts/OracleRouter.sol::submitMeasurement`). This module mirrors the
 * exact same recovery scheme to fail-fast off-chain so the relayer never
 * spends gas on a packet the contract would revert anyway.
 *
 * Critically: the off-chain recovery uses byte-for-byte the same
 * `EXERGY_SIGNATURE_DIALECT_V0` documented in `docs/PROTOCOL_SPEC.md`. Any
 * divergence between this module and the contract is a CONCEPT_AUDIT D-1
 * regression and must be caught immediately.
 *
 * Recovery scheme (V0):
 *
 *   packetHash    = keccak256(abi.encode(packet))                          // bytes32
 *   deviceDigest  = keccak256("\x19Ethereum Signed Message:\n32" || packetHash)
 *   recoveredDev  = ecrecover(deviceDigest, deviceSignature)
 *
 *   vppPayload    = keccak256(abi.encode(packetHash, deviceSignature))
 *   vppDigest     = keccak256("\x19Ethereum Signed Message:\n32" || vppPayload)
 *   recoveredVPP  = ecrecover(vppDigest, vppSignature)
 *
 * The on-chain registry binding (recoveredDev hash → registered device,
 * recoveredVPP → registered VPP for that device) is verified by the contract,
 * not here. The adapter is stateless: it does not maintain a device registry.
 * That is intentional — multiple adapters can run in parallel without sharing
 * mutable state.
 */
import { AbiCoder, getBytes, keccak256, solidityPackedKeccak256, verifyMessage } from 'ethers';
import type { MeasurementPacket, ValidationResult } from './types';
import { child } from './logger';

const log = child('verifier');

/**
 * ABI types in field order — keep IN SYNC with `IOracleRouter.MeasurementPacket`.
 * Drift here = silent rejection on chain.
 */
const PACKET_ABI_TYPES = [
  'bytes32', // deviceId
  'uint256', // kwhAmount
  'uint64',  // timestamp
  'uint256', // storageCapacity
  'uint8',   // chargeLevelPercent
  'uint8',   // sourceType
  'uint32',  // cumulativeCycles
] as const;

/** Compute the canonical packet hash (bytes32). Pure. */
export function computePacketHash(p: MeasurementPacket): string {
  const encoded = AbiCoder.defaultAbiCoder().encode([...PACKET_ABI_TYPES], [
    p.deviceId,
    p.kwhAmount,
    p.timestamp,
    p.storageCapacity,
    p.chargeLevelPercent,
    p.sourceType,
    p.cumulativeCycles,
  ]);
  return keccak256(encoded);
}

/**
 * Verify both signatures off-chain. Returns the recovered addresses + pubKeyHash
 * the contract will look up in its registry. Does NOT consult any registry —
 * the contract owns that decision (defence-in-depth: the adapter is replaceable
 * but the contract's registry is the source of truth).
 */
export function verifyDualSignature(
  packet: MeasurementPacket,
  deviceSignature: string,
  vppSignature: string,
): ValidationResult {
  const packetHash = computePacketHash(packet);

  // ---- Device signature ----
  let recoveredDevice: string;
  try {
    // verifyMessage applies EIP-191 prefix internally — exactly what the
    // contract's MessageHashUtils.toEthSignedMessageHash does. Pass raw bytes
    // so the length-prefix is "32" and the digest matches byte-for-byte.
    recoveredDevice = verifyMessage(getBytes(packetHash), deviceSignature).toLowerCase();
  } catch (err) {
    const reason = `device signature recovery failed: ${err instanceof Error ? err.message : String(err)}`;
    log.warn('reject', { reason, deviceId: packet.deviceId });
    return { ok: false, reason };
  }

  // The contract stores keccak256(abi.encodePacked(deviceAddress)) in
  // _devices[deviceId].devicePubKeyHash. We compute the same value so the
  // server log can report it for human comparison if needed.
  const devicePubKeyHash = solidityPackedKeccak256(['address'], [recoveredDevice]);

  // ---- VPP cosignature ----
  // Inner abi.encode types are EXACTLY (bytes32, bytes). NOT (packet, bytes),
  // NOT (bytes32, bytes, address). See PROTOCOL_SPEC.md §4 — adding a third
  // field is the historic CONCEPT_AUDIT D-1 bug.
  const vppPayload = AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'bytes'],
    [packetHash, deviceSignature],
  );
  const vppPayloadHash = keccak256(vppPayload);

  let recoveredVPP: string;
  try {
    recoveredVPP = verifyMessage(getBytes(vppPayloadHash), vppSignature).toLowerCase();
  } catch (err) {
    const reason = `vpp signature recovery failed: ${err instanceof Error ? err.message : String(err)}`;
    log.warn('reject', { reason, deviceId: packet.deviceId });
    return { ok: false, reason };
  }

  log.debug('verified', {
    deviceId: packet.deviceId,
    deviceAddress: recoveredDevice,
    vppAddress: recoveredVPP,
    packetHash,
  });

  return {
    ok: true,
    deviceAddress: recoveredDevice,
    devicePubKeyHash,
    vppAddress: recoveredVPP,
    packetHash,
  };
}
