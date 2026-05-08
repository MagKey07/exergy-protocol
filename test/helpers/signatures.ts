// Helpers for building and signing MeasurementPackets the way OracleRouter
// expects them.
//
// The OracleRouter interface (contracts/interfaces/IOracleRouter.sol) declares:
//   submitMeasurement(MeasurementPacket packet, bytes deviceSignature, bytes vppSignature)
//   - deviceSignature signs keccak256(abi.encode(packet))
//   - vppSignature   signs keccak256(abi.encode(packet, deviceSignature))
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
 * Sign a packet as the device. Uses signMessage (EIP-191 prefixed) so the
 * contract can recover via ECDSA.recover after applying the same prefix —
 * this matches the most common OZ ECDSA usage. If the contracts agent opts
 * for raw signMessage instead, only `signDevice` and `signVpp` need updating.
 */
export async function signDevice(
  packet: MeasurementPacket,
  device: Wallet | HDNodeWallet
): Promise<string> {
  const hash = packetHash(packet);
  // arrayify to hash bytes; signMessage will re-prefix with EIP-191
  return device.signMessage(ethers.getBytes(hash));
}

export async function signVpp(
  packet: MeasurementPacket,
  deviceSignature: string,
  vppCloud: Wallet | HDNodeWallet
): Promise<string> {
  const inner = ethers.AbiCoder.defaultAbiCoder().encode(
    [PACKET_TUPLE, "bytes"],
    [packet, deviceSignature]
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
  // ethers exposes signingKey.publicKey as 0x04|X|Y (uncompressed, 65 bytes).
  // The spec says keccak256 of the public key — strip the 0x04 prefix to match
  // the Ethereum address derivation convention.
  const pub = w.signingKey.publicKey; // 0x04...
  const stripped = "0x" + pub.slice(4);
  return ethers.keccak256(stripped);
}
