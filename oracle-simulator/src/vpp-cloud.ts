/**
 * @file vpp-cloud.ts
 * @description Mock VPP cloud (the operator-side signer in the dual-signature
 * pipeline). In production this is a server cluster running inside the VPP
 * operator's environment that:
 *   - cross-validates BMS data against SCADA / inverter telemetry,
 *   - rejects obviously bogus packets before they leave the building,
 *   - co-signs valid packets with the VPP's ECDSA identity,
 *   - forwards to the Chainlink External Adapter.
 *
 * Here we model the validation as: "device signature must recover to the
 * registered device address". If it does, we co-sign. If it doesn't, we drop
 * the packet and log loudly.
 */
import { AbiCoder, keccak256, getBytes, verifyMessage, type Wallet } from 'ethers';
import type { Keypair } from './keypair';
import type { SignedDevicePacket, DualSignedPacket } from './types';
import { buildDeviceDigest } from './edge-device';
import { child } from './logger';

const log = child('vpp-cloud');

/**
 * Field types for the VPP-level digest. We bind:
 *  - the device digest (so the device's exact reading is committed to),
 *  - the device signature (so a swap of signatures is detected),
 *  - the VPP cloud's address (so a different VPP can't forward our packet).
 */
const VPP_DIGEST_TYPES = ['bytes32', 'bytes', 'address'] as const;

/** Compute the bytes32 digest the VPP cloud signs. */
export function buildVppDigest(packet: SignedDevicePacket, vppAddress: string): string {
  const deviceDigest = buildDeviceDigest(packet);
  const encoded = AbiCoder.defaultAbiCoder().encode([...VPP_DIGEST_TYPES], [
    deviceDigest,
    packet.deviceSignature,
    vppAddress,
  ]);
  return keccak256(encoded);
}

/**
 * Registry of trusted devices known to this VPP. Maps deviceId -> expected
 * signer address. In production this is a database row; here it's an in-memory
 * map. The same registry is mirrored on-chain in OracleRouter.deviceToVpp.
 */
export class DeviceRegistry {
  private readonly map = new Map<string, string>();

  register(deviceId: string, expectedSigner: string): void {
    this.map.set(deviceId.toLowerCase(), expectedSigner.toLowerCase());
  }

  expectedSigner(deviceId: string): string | undefined {
    return this.map.get(deviceId.toLowerCase());
  }

  size(): number {
    return this.map.size;
  }
}

export class VppValidationError extends Error {
  readonly code: 'UNKNOWN_DEVICE' | 'BAD_SIGNATURE';
  constructor(code: 'UNKNOWN_DEVICE' | 'BAD_SIGNATURE', message: string) {
    super(message);
    this.code = code;
    this.name = 'VppValidationError';
  }
}

export class VppCloud {
  private readonly wallet: Wallet;

  constructor(
    private readonly keypair: Keypair,
    private readonly registry: DeviceRegistry,
  ) {
    this.wallet = keypair.wallet;
  }

  /** VPP cloud's on-chain identity. Must match OracleRouter.vppRegistry[address]. */
  get address(): string {
    return this.keypair.address;
  }

  /**
   * Validate the device portion and co-sign. Returns the dual-signed packet
   * ready for on-chain submission. Throws VppValidationError on failure.
   */
  async cosign(packet: SignedDevicePacket): Promise<DualSignedPacket> {
    const expected = this.registry.expectedSigner(packet.deviceId);
    if (!expected) {
      throw new VppValidationError(
        'UNKNOWN_DEVICE',
        `deviceId ${packet.deviceId} is not registered with VPP ${this.address}`,
      );
    }

    // verifyMessage applies EIP-191 prefix + keccak; matches edge-device.sign().
    const recovered = verifyMessage(getBytes(buildDeviceDigest(packet)), packet.deviceSignature).toLowerCase();
    if (recovered !== expected) {
      throw new VppValidationError(
        'BAD_SIGNATURE',
        `recovered ${recovered} != expected ${expected} for device ${packet.deviceId}`,
      );
    }

    const vppDigest = buildVppDigest(packet, this.address);
    const vppSignature = await this.wallet.signMessage(getBytes(vppDigest));

    log.debug('cosigned', {
      deviceId: packet.deviceId,
      vppAddress: this.address,
      vppDigest,
    });

    return {
      ...packet,
      vppDigest,
      vppAddress: this.address,
      vppSignature,
    };
  }

  /**
   * Convenience: cosign a batch and return only the successfully verified
   * packets. Failed packets are logged and dropped — they never reach the
   * chain. Mirrors real-world VPP behaviour where bogus telemetry is filtered
   * inside the operator's network.
   */
  async cosignBatch(batch: readonly SignedDevicePacket[]): Promise<{
    readonly accepted: readonly DualSignedPacket[];
    readonly rejected: readonly { readonly packet: SignedDevicePacket; readonly error: string }[];
  }> {
    const accepted: DualSignedPacket[] = [];
    const rejected: { packet: SignedDevicePacket; error: string }[] = [];
    for (const p of batch) {
      try {
        accepted.push(await this.cosign(p));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('rejected', { deviceId: p.deviceId, error: msg });
        rejected.push({ packet: p, error: msg });
      }
    }
    return { accepted, rejected };
  }
}
