// Helpers for building and signing MeasurementPackets the way OracleRouter
// expects them.
//
// CANONICAL ENCODING (per OracleRouter.sol:160, 166, 175-176 — see also
// docs/PROTOCOL_SPEC.md, EXERGY_SIGNATURE_DIALECT_V0):
//
//   packetHash    = keccak256(abi.encode(packet))         // bytes32
//   deviceDigest  = "\x19Ethereum Signed Message:\n32" || packetHash, then keccak
//   vppPayload    = keccak256(abi.encode(packetHash, deviceSignature))   // bytes32
//   vppDigest     = "\x19Ethereum Signed Message:\n32" || vppPayload, then keccak
//
// Both signatures are produced via `wallet.signMessage(getBytes(<hash>))`
// which applies the EIP-191 prefix internally and is recovered on-chain via
// `MessageHashUtils.toEthSignedMessageHash(...).recover(sig)`.
//
// IMPORTANT: the VPP digest's INNER `abi.encode` takes `(bytes32, bytes)` —
// i.e. the device packet HASH, not the packet struct itself. An earlier
// version of this helper encoded the struct again; that diverged from the
// contract and broke interop. See CONCEPT_AUDIT.md D-1.
//
// In tests, signers are local ethers.Wallets so we can deterministically derive
// addresses for device + VPP cloud and register them in OracleRouter.

import { ethers } from "hardhat";
import type { HDNodeWallet, Wallet } from "ethers";

export interface MeasurementPacket {
  deviceId: string; // bytes32 (0x-prefixed)
  kwhAmount: bigint;
  timestamp: number; // unix seconds (uint64)
  storageCapacity: bigint;
  chargeLevelPercent: number; // uint8
  sourceType: number; // uint8 (0=solar, 1=wind, 2=hydro, 3=other)
  cumulativeCycles: number; // uint32
}

/** Solidity-equivalent struct encoding for keccak256(abi.encode(packet)). */
const PACKET_TUPLE =
  "tuple(bytes32 deviceId,uint256 kwhAmount,uint64 timestamp,uint256 storageCapacity,uint8 chargeLevelPercent,uint8 sourceType,uint32 cumulativeCycles)";

export function encodePacket(packet: MeasurementPacket): string {
  return ethers.AbiCoder.defaultAbiCoder().encode([PACKET_TUPLE], [packet]);
}

export function packetHash(packet: MeasurementPacket): string {
  return ethers.keccak256(encodePacket(packet));
}

/**
 * Sign a packet as the device. Uses signMessage (EIP-191 prefixed) — the
 * contract recovers via `packetHash.toEthSignedMessageHash().recover(sig)` so
 * the prefix is applied on both sides and the bytes match.
 */
export async function signDevice(
  packet: MeasurementPacket,
  device: Wallet | HDNodeWallet
): Promise<string> {
  const hash = packetHash(packet);
  // arrayify to hash bytes; signMessage will re-prefix with EIP-191
  return device.signMessage(ethers.getBytes(hash));
}

/**
 * Sign the VPP cosignature.
 *
 * CANONICAL: `keccak256(abi.encode(packetHash :: bytes32, deviceSignature :: bytes))`
 * (per OracleRouter.sol:175). The inner `abi.encode` takes the device-digest
 * HASH, not the packet struct. Encoding the struct again (older buggy variant)
 * produces a different vppPayloadHash and the contract reverts with
 * `InvalidVPPSignature`.
 */
export async function signVpp(
  packet: MeasurementPacket,
  deviceSignature: string,
  vppCloud: Wallet | HDNodeWallet
): Promise<string> {
  const pHash = packetHash(packet);
  const inner = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bytes"],
    [pHash, deviceSignature]
  );
  const hash = ethers.keccak256(inner);
  return vppCloud.signMessage(ethers.getBytes(hash));
}

/** Convenience for tests: build a default packet around overrides. */
export function makePacket(overrides: Partial<MeasurementPacket> = {}): MeasurementPacket {
  return {
    deviceId: ethers.id("device-1"), // bytes32 keccak("device-1")
    kwhAmount: 100n,
    timestamp: Math.floor(Date.now() / 1000),
    storageCapacity: 13_500n, // 13.5 kWh Powerwall scaled to integer kWh
    chargeLevelPercent: 80,
    sourceType: 0, // solar
    cumulativeCycles: 100,
    ...overrides,
  };
}

/** Quick standalone wallet seeded from a known mnemonic for reproducibility. */
export function makeWallet(seed: string): Wallet {
  // keccak the seed and use it as private key (avoid weak keys)
  const pk = ethers.keccak256(ethers.toUtf8Bytes("xrgy-test:" + seed));
  return new ethers.Wallet(pk);
}

/** keccak256 of a wallet's *uncompressed* public key, matching the spec. */
export function devicePubKeyHash(w: Wallet | HDNodeWallet): string {
  // CONTRACT TRUTH: OracleRouter does keccak256(abi.encodePacked(recoveredAddress))
  // i.e. hash of the 20-byte address (NOT uncompressed pubkey).
  // See OracleRouter.sol — keccak256(abi.encodePacked(recoveredDevice)) != rec.devicePubKeyHash.
  return ethers.solidityPackedKeccak256(["address"], [w.address]);
}
