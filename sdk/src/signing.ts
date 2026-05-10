import {
  AbiCoder,
  getBytes,
  keccak256,
  solidityPackedKeccak256,
  Wallet,
} from "ethers";

import { buildPacketHash, MeasurementPacket } from "./packet";

/**
 * Compute the on-chain `devicePubKeyHash` for a given device wallet.
 *
 * IMPORTANT: the contract stores and verifies the hash of the recovered
 * 20-byte Ethereum address — NOT the hash of the 64-byte uncompressed
 * secp256k1 public key. Computing the wrong digest is the single most
 * common integration failure mode.
 *
 * Equivalent in Solidity terms:
 *   keccak256(abi.encodePacked(address))
 */
export function devicePubKeyHashFor(deviceAddress: string): string {
  return solidityPackedKeccak256(["address"], [deviceAddress]);
}

/**
 * The VPP digest is `keccak256(abi.encode(packetHash, deviceSignature))`.
 *
 * The inner encoding is exactly two fields — `(bytes32, bytes)`. The VPP
 * address is NOT included. An older spec mistakenly encoded a third
 * `address` field; that variant fails on-chain recovery.
 */
export function buildVppDigest(
  packetHash: string,
  deviceSignature: string,
): string {
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bytes"],
    [packetHash, deviceSignature],
  );
  return keccak256(encoded);
}

export interface SignPacketArgs {
  packet: MeasurementPacket;
  deviceWallet: Wallet;
  vppCloudWallet: Wallet;
}

export interface SignedPacket {
  packetHash: string;
  deviceSignature: string;
  vppSignature: string;
}

/**
 * Produce the dual signature for a measurement packet.
 *
 * Step 1: device signs the packet hash with EIP-191 prefix
 *         (Ethereum signed message: 32-byte digest).
 * Step 2: VPP cloud signs the VPP digest with the same EIP-191 prefix.
 *
 * Both `signMessage` calls in ethers v6 prepend `"\x19Ethereum Signed Message:\n32"`
 * before re-hashing — matching OpenZeppelin's `MessageHashUtils.toEthSignedMessageHash`.
 */
export async function signPacket(args: SignPacketArgs): Promise<SignedPacket> {
  const packetHash = buildPacketHash(args.packet);

  const deviceSignature = await args.deviceWallet.signMessage(
    getBytes(packetHash),
  );

  const vppDigest = buildVppDigest(packetHash, deviceSignature);
  const vppSignature = await args.vppCloudWallet.signMessage(
    getBytes(vppDigest),
  );

  return { packetHash, deviceSignature, vppSignature };
}
