/**
 * @file edge-device.ts
 * @description Mock edge device (Pi 5 + ATECC608B HSM in production).
 *
 * Responsibilities:
 *  1. Receive a BmsReading from the simulated battery.
 *  2. Compute the canonical digest using the same ABI encoding the on-chain
 *     OracleRouter will use to verify the signature.
 *  3. Sign the digest with the device's ECDSA secp256k1 key (HSM in real life).
 *  4. Emit a SignedDevicePacket ready for the VPP cloud to co-sign.
 *
 * On-chain verification expectation:
 *   bytes32 digest = keccak256(abi.encode(
 *       deviceId, kwhAmount, timestamp, storageCapacity,
 *       chargeLevelPercent, sourceType, cumulativeCycles));
 *   address signer = ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(digest), sig);
 *
 * We use the EIP-191 "\x19Ethereum Signed Message:\n32" prefix because that's
 * what ethers' Wallet.signMessage produces and what OpenZeppelin's
 * MessageHashUtils.toEthSignedMessageHash builds. If the smart-contracts agent
 * prefers raw-digest recovery (no EIP-191), they can flip the verifier to
 * ECDSA.recover(digest, sig) directly — see DEVICE_DIGEST_RAW below.
 */
import { AbiCoder, getBytes, keccak256, type Wallet } from 'ethers';
import type { BmsReading, SignedDevicePacket } from './types';
import type { Keypair } from './keypair';
import { child } from './logger';

const log = child('edge-device');

/**
 * ABI types in field order. KEEP IN SYNC with OracleRouter.sol — same order
 * and same widths. abi.encode (NOT encodePacked) so widths are explicit.
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

/**
 * Compute the canonical bytes32 digest the device signs. Exposed so the
 * smart-contracts agent can mirror it in tests, and so vpp-cloud.ts can
 * include it deterministically inside its own signature.
 */
export function buildDeviceDigest(reading: BmsReading): string {
  const encoded = AbiCoder.defaultAbiCoder().encode([...PACKET_ABI_TYPES], [
    reading.deviceId,
    reading.kwhAmount,
    reading.timestamp,
    reading.storageCapacity,
    reading.chargeLevelPercent,
    reading.sourceType,
    reading.cumulativeCycles,
  ]);
  return keccak256(encoded);
}

/**
 * Mock edge device. Real device firmware would call into the HSM (ATECC608B)
 * via I2C; here we sign with an in-memory ethers Wallet. Signature semantics
 * are otherwise identical: 65-byte (r,s,v) over keccak256 of EIP-191-prefixed
 * digest.
 */
export class EdgeDevice {
  private readonly wallet: Wallet;

  constructor(private readonly keypair: Keypair) {
    this.wallet = keypair.wallet;
  }

  /** Address derived from the device's signing key. Used for log correlation. */
  get address(): string {
    return this.keypair.address;
  }

  /** Public key hash (bytes32) — what OracleRouter stores in its registry. */
  get pubKeyHash(): string {
    return this.keypair.pubKeyHash;
  }

  /**
   * Sign a BMS reading. Returns the SignedDevicePacket (original fields +
   * deviceSignature). Async because Wallet.signMessage is async even when the
   * key is in-memory — keeps the API consistent with future HSM integration
   * (which will be I2C-bound and definitely async).
   */
  async sign(reading: BmsReading): Promise<SignedDevicePacket> {
    const digest = buildDeviceDigest(reading);
    // EIP-191: ethers v6 Wallet.signMessage prepends "\x19Ethereum Signed Message:\n32"
    // to the *bytes* of the digest, then keccak256s. To make the on-chain
    // verifier simple we pass raw digest bytes (not the hex string) so the
    // length-prefix is "32" and OpenZeppelin's toEthSignedMessageHash matches.
    const signature = await this.wallet.signMessage(getBytes(digest));

    log.debug('signed', {
      deviceId: reading.deviceId,
      signer: this.wallet.address,
      digest,
      kwh: reading.kwhAmount.toString(),
    });

    return { ...reading, deviceSignature: signature };
  }
}

/**
 * Exposed for tests / smart-contracts agent: the raw (unprefixed) digest.
 * If the OracleRouter chooses NOT to apply EIP-191 prefixing, the verifier
 * should ECDSA.recover(this digest, sig) directly. Either path works — the
 * contract author picks one and we mirror.
 */
export const DEVICE_DIGEST_RAW = buildDeviceDigest;
