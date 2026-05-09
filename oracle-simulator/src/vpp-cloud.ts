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
 * Field types for the VPP-level digest — CANONICAL per `OracleRouter.sol:175`:
 *
 *   bytes32 vppPayloadHash = keccak256(abi.encode(packetHash, deviceSignature));
 *
 * We bind:
 *  - the device digest (so the device's exact reading is committed to),
 *  - the device signature (so a swap of signatures is detected).
 *
 * NOTE on `vppAddress`: an earlier draft of this file included `vppAddress` as a
 * third field. The contract does NOT include it (it relies on the device→VPP
 * binding stored in the on-chain registry instead). Including it here broke
 * interop — exactly the "centralized software gatekeeping" risk CORE_THESIS
 * warns against. The canonical encoding is `[bytes32, bytes]`. See
 * `docs/PROTOCOL_SPEC.md` for the full dialect (EXERGY_SIGNATURE_DIALECT_V0).
 */
const VPP_DIGEST_TYPES = ['bytes32', 'bytes'] as const;

/**
 * Compute the bytes32 digest the VPP cloud signs.
 *
 * Reference implementation that any third-party VPP-cloud signer can call
 * (or re-implement byte-for-byte) — see `docs/PROTOCOL_SPEC.md`.
 *
 * @param packet The device-signed packet (already carries `deviceSignature`).
 * @returns The bytes32 digest, ready to be passed to `wallet.signMessage(getBytes(...))`.
 */
export function buildVppDigest(packet: SignedDevicePacket): string {
  const deviceDigest = buildDeviceDigest(packet);
  const encoded = AbiCoder.defaultAbiCoder().encode([...VPP_DIGEST_TYPES], [
    deviceDigest,
    packet.deviceSignature,
  ]);
  return keccak256(encoded);
}

/**
 * Reference TS cosignature builder — pure function, no class state.
 *
 * Exposed so other VPP-cloud implementations can consume this as a
 * REFERENCE (not a shim). Re-export-friendly: a Gmail/Outlook-style
 * ecosystem of cloud signers can either import this directly or
 * mirror the byte sequence in their own runtime.
 *
 * @param packet  Device-signed packet (must carry `deviceSignature`).
 * @param sign    Async signing function — e.g. `wallet.signMessage(bytes)`.
 *                Must apply EIP-191 prefix (matches OracleRouter.sol:176).
 */
export async function cosignReference(
  packet: SignedDevicePacket,
  sign: (digestBytes: Uint8Array) => Promise<string>,
): Promise<{ vppDigest: string; vppSignature: string }> {
  const vppDigest = buildVppDigest(packet);
  const vppSignature = await sign(getBytes(vppDigest));
  return { vppDigest, vppSignature };
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

    const vppDigest = buildVppDigest(packet);
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
