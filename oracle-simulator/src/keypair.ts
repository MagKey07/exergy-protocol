/**
 * @file keypair.ts
 * @description ECDSA secp256k1 key management for mock devices and VPP clouds.
 *
 * Production reality: device keys live in an ATECC608B HSM and never leave the
 * chip. The simulator instead derives a deterministic key from a string seed so
 * that re-running the simulator produces stable identities — easier to register
 * once on-chain and re-use across runs.
 */
import { Wallet, HDNodeWallet, Mnemonic, getBytes, hexlify, keccak256, toUtf8Bytes } from 'ethers';

/**
 * A keyring binding a private key to its derived address + public key hash.
 * `pubKeyHash` is what OracleRouter stores in the device registry (per blueprint).
 */
export interface Keypair {
  readonly privateKey: string;
  readonly address: string;
  /** keccak256 of the uncompressed public key (without 0x04 prefix), per Ethereum convention. */
  readonly pubKeyHash: string;
  readonly wallet: Wallet;
}

/**
 * Build a keypair from a 32-byte hex private key (with or without 0x).
 * Throws if the key is malformed (lets ethers' validation surface).
 */
export function fromPrivateKey(privateKey: string): Keypair {
  const wallet = new Wallet(privateKey);
  return wrap(wallet);
}

/**
 * Derive a deterministic keypair from any string seed. We hash the seed with
 * keccak256 to get 32 bytes, then treat that as the private key. Same seed
 * always yields the same key — useful for stable device identities across
 * simulator restarts without committing real keys to disk.
 *
 * NOT for production. This is a mock; an ATECC608B generates the key inside
 * the chip and the private bytes never exist in memory.
 */
export function fromSeed(seed: string): Keypair {
  const digest = keccak256(toUtf8Bytes(`exergy-sim:${seed}`));
  return fromPrivateKey(digest);
}

/** Generate a fresh random keypair (cryptographically random). */
export function random(): Keypair {
  const wallet = Wallet.createRandom();
  // Wallet.createRandom returns HDNodeWallet, but its private key is full;
  // we wrap it as a plain Wallet to drop the unused HD path metadata.
  return wrap(new Wallet(wallet.privateKey));
}

/**
 * Build a deterministic device id (bytes32) from a human-readable label.
 * The OracleRouter registry uses bytes32 deviceId; we hash the label so any
 * label length works. Label "vpp-tx-01:device-3" is friendlier than a random
 * 32-byte blob and stays stable across runs.
 */
export function deviceIdFromLabel(label: string): string {
  return keccak256(toUtf8Bytes(`exergy-device:${label}`));
}

/**
 * Convenience: derive a fleet of N device keypairs + ids from a vpp label.
 * Each device is keyed on `${vppLabel}:device-${i}` so the smart-contracts
 * agent can pre-register the fleet from the same labels.
 */
export function deviceFleet(
  vppLabel: string,
  count: number,
): readonly { readonly deviceId: string; readonly keypair: Keypair; readonly label: string }[] {
  const out: { readonly deviceId: string; readonly keypair: Keypair; readonly label: string }[] = [];
  for (let i = 0; i < count; i++) {
    const label = `${vppLabel}:device-${String(i).padStart(3, '0')}`;
    out.push({
      deviceId: deviceIdFromLabel(label),
      keypair: fromSeed(label),
      label,
    });
  }
  return out;
}

/* ---------------- helpers ---------------- */

function wrap(wallet: Wallet | HDNodeWallet): Keypair {
  const w = wallet instanceof Wallet ? wallet : new Wallet(wallet.privateKey);
  return {
    privateKey: w.privateKey,
    address: w.address,
    pubKeyHash: pubKeyHashFromWallet(w),
    wallet: w,
  };
}

/**
 * Compute keccak256(uncompressedPubKey[1:]) — the same hash Ethereum uses to
 * derive an address (lower 20 bytes). We expose the full 32-byte hash for the
 * registry, since OracleRouter stores `bytes32 pubKeyHash`.
 */
function pubKeyHashFromWallet(w: Wallet): string {
  // ethers v6: signingKey.publicKey returns 0x04 || X || Y (uncompressed, 65 bytes hex).
  const uncompressed = w.signingKey.publicKey;
  const bytes = getBytes(uncompressed);
  if (bytes.length !== 65 || bytes[0] !== 0x04) {
    throw new Error(`Unexpected pubkey format: length=${bytes.length} prefix=${bytes[0]?.toString(16)}`);
  }
  return keccak256(hexlify(bytes.slice(1)));
}

/**
 * Suppress an unused-mnemonic-import warning during type-check while keeping
 * the symbol available for future deterministic-fleet expansions (e.g. BIP-39
 * derivation paths per VPP). Tree-shake-safe: pure value reference.
 */
export const __unusedMnemonic = Mnemonic;
