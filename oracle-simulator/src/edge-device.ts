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
 * On-chain verification expectation (CANONICAL — see OracleRouter.sol:160-167):
 *   bytes32 packetHash = keccak256(abi.encode(packet));     // packet is the full struct
 *   bytes32 deviceDigest = MessageHashUtils.toEthSignedMessageHash(packetHash);
 *   address signer = ECDSA.recover(deviceDigest, deviceSignature);
 *
 * Two equivalences that make the simulator's implementation correct:
 *   (a) abi.encode(packet) == abi.encode(field1, field2, ..., fieldN)
 *       when every field is static-size (no dynamic types). All MeasurementPacket
 *       fields are static (bytes32, uint256, uint64, uint256, uint8, uint8, uint32),
 *       so encoding the struct or its fields produces identical bytes.
 *   (b) ethers.Wallet.signMessage(getBytes(hash)) prepends
 *       "\x19Ethereum Signed Message:\n32" + hashBytes, then keccaks — exactly
 *       what OpenZeppelin's MessageHashUtils.toEthSignedMessageHash produces.
 *
 * This is EXERGY_SIGNATURE_DIALECT_V0 (see docs/PROTOCOL_SPEC.md). Production
 * may move to EIP-712 typed data; Phase 0 stays simple.
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
    // to the *bytes* of the digest, then keccak256s. We pass raw digest bytes
    // (not the hex string) so the length-prefix is "32" and OpenZeppelin's
    // MessageHashUtils.toEthSignedMessageHash matches byte-for-byte. This is
    // the canonical dialect per OracleRouter.sol:166.
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
 * Exposed for tests / third-party signers: the raw (unprefixed) digest.
 *
 * The currently-canonical dialect (V0) applies EIP-191 prefixing on top of
 * this digest before recovery — `EdgeDevice.sign` does that automatically via
 * `wallet.signMessage`. This export is kept so reference tests can compute
 * the inner digest for cross-validation against `signatures.ts::packetHash`.
 *
 * See `docs/PROTOCOL_SPEC.md` for the canonical dialect.
 */
export const DEVICE_DIGEST_RAW = buildDeviceDigest;
