# Exergy Protocol — Dual-Signature Dialect

**Version:** `EXERGY_SIGNATURE_DIALECT_V0`
**Phase:** Phase 0 (testnet demo). Production may move to EIP-712 typed data.
**Audience:** Any third-party VPP-cloud implementer, Chainlink External
Adapter author, alternative edge-device firmware vendor, auditor.
**Source of truth:** `contracts/OracleRouter.sol` (immutable in this commit).
This document describes what the contract does — if a discrepancy is found,
the contract bytecode is canonical and this spec is the bug.

---

## 1. Why this document exists

CORE_THESIS commits us to "no centralized software gatekeeping" — multiple
implementations (the Exergy reference simulator, an in-house cloud written by
a VPP partner, a future Chainlink External Adapter, an alternative edge-device
firmware) must interoperate over the same byte-level protocol. That requires
an unambiguous spec of:

1. The exact ABI encoding the device signs.
2. The exact ABI encoding the VPP cloud cosigns.
3. The signature recovery scheme on-chain (prefix decisions, curve, etc).
4. The on-chain rejection rules (Anti-Simulation Lock).

Anything left to implementers' interpretation is a failure mode that gets
exploited by the first interop attempt — exactly what we saw in
`CONCEPT_AUDIT.md` Drift D-1, where three "canonical" encodings disagreed.

---

## 2. Packet schema — `MeasurementPacket`

Solidity declaration: `contracts/interfaces/IOracleRouter.sol:27-35`.

| Field                  | Solidity type | Semantics                                                                 |
|------------------------|---------------|---------------------------------------------------------------------------|
| `deviceId`             | `bytes32`     | Stable on-chain identifier of the physical device. Registry key.          |
| `kwhAmount`            | `uint256`     | Integer kWh delivered into storage during this measurement window.        |
| `timestamp`            | `uint64`      | Unix seconds when the BMS captured the reading. Window-checked on chain.  |
| `storageCapacity`      | `uint256`     | Nameplate storage capacity of the battery (wei-scaled — 18 decimals).     |
| `chargeLevelPercent`   | `uint8`       | State-of-charge at sample time, integer 0..100.                           |
| `sourceType`           | `uint8`       | 0 = solar, 1 = wind, 2 = hydro, 3 = other. Stable; do not renumber.       |
| `cumulativeCycles`     | `uint32`      | Proof-of-Wear: cumulative full-equivalent cycles to date.                 |

All fields are static-size. Therefore `abi.encode(packet)` produces identical
bytes to `abi.encode(deviceId, kwhAmount, timestamp, storageCapacity,
chargeLevelPercent, sourceType, cumulativeCycles)`. Implementations may
encode either way and they MUST agree byte-for-byte.

### Time-window rules (enforced on chain)

- `packet.timestamp ≤ block.timestamp + 5 minutes` (clock-skew tolerance).
- `block.timestamp ≤ packet.timestamp + 72 hours` (max backdating grace).

A packet outside the window reverts with `TimestampOutOfWindow`.

### Replay protection

A packet hash (`keccak256(abi.encode(packet))`) is consumed on first
acceptance; resubmission reverts with `DuplicateMeasurement`.

---

## 3. Device signature

```
packetHash    = keccak256(abi.encode(packet))                       // bytes32
deviceDigest  = keccak256("\x19Ethereum Signed Message:\n32" || packetHash)
deviceSig     = secp256k1.sign(deviceDigest, devicePrivateKey)      // 65 bytes (r,s,v)
```

Recovery on chain (`OracleRouter.sol:166-167`):

```solidity
bytes32 deviceDigest = packetHash.toEthSignedMessageHash();
address recoveredDevice = deviceDigest.recover(deviceSignature);
```

**Why EIP-191 prefix:** every wallet, HSM SDK, and `personal_sign`-style API
emits this prefix by default. Picking it for V0 means a third-party can sign
with `eth_sign` / `personal_sign` / `wallet.signMessage(getBytes(hash))`
without writing custom firmware. Production may switch to EIP-712 typed-data
signing for richer DApp-side UX; this is a V1 decision.

### Device registry binding

The contract stores a `devicePubKeyHash` per `deviceId`. The check is:

```solidity
if (keccak256(abi.encodePacked(recoveredDevice)) != rec.devicePubKeyHash) {
    revert InvalidDeviceSignature();
}
```

So `devicePubKeyHash = keccak256(<20-byte device address>)`. The
"public key hash" terminology in earlier drafts is a misnomer — the registry
stores the keccak of the recovered ETHEREUM ADDRESS, not the keccak of the
secp256k1 public key. Implementers should compute it as:

```typescript
const devicePubKeyHash = keccak256(getBytes(deviceAddress)); // 20 bytes -> bytes32
```

---

## 4. VPP cosignature

```
vppPayload   = keccak256(abi.encode(packetHash /*bytes32*/, deviceSignature /*bytes*/))
vppDigest    = keccak256("\x19Ethereum Signed Message:\n32" || vppPayload)
vppSig       = secp256k1.sign(vppDigest, vppCloudPrivateKey)
```

Recovery on chain (`OracleRouter.sol:175-178`):

```solidity
bytes32 vppPayloadHash = keccak256(abi.encode(packetHash, deviceSignature));
bytes32 vppDigest = vppPayloadHash.toEthSignedMessageHash();
address recoveredVPP = vppDigest.recover(vppSignature);
if (recoveredVPP != rec.vppAddress) revert InvalidVPPSignature();
```

**Inner abi.encode types are EXACTLY `(bytes32, bytes)`.** Not `(packet, bytes)`,
not `(bytes32, bytes, address)`. Adding a third field (e.g. the VPP's address)
diverges the digest and the contract rejects. The device → VPP binding lives
in the on-chain registry, not in the cosignature payload.

---

## 5. Anti-Simulation Lock

The contract REJECTS submissions unless ALL of the following hold:

1. `_devices[packet.deviceId].vppAddress != 0` (device is registered).
2. `_devices[packet.deviceId].active` (device is currently active).
3. Time window check passes.
4. Packet hash has not been consumed before.
5. Recovered device address hashes to the registered `devicePubKeyHash`.
6. Recovered VPP address equals the registered `vppAddress` for this device.

There is no admin override. No multisig bypass. No "trusted partner" allowlist
that skips checks. A single signature, a swapped signature, or a forwarded
packet from a different VPP all fail at points (5) or (6) and revert.

This is the trust boundary — once it accepts a packet, the rest of the
protocol (MintingEngine, halving, floating index) is deterministic arithmetic.

---

## 6. Reference TypeScript snippet

This is the minimum byte-correct implementation. Any third-party signer that
matches these ~20 lines interoperates with the deployed contract.

```typescript
import { AbiCoder, getBytes, keccak256, Wallet } from 'ethers';

const PACKET_ABI_TYPES = [
  'bytes32', 'uint256', 'uint64', 'uint256', 'uint8', 'uint8', 'uint32',
] as const;

function packetHash(p: MeasurementPacket): string {
  const encoded = AbiCoder.defaultAbiCoder().encode([...PACKET_ABI_TYPES], [
    p.deviceId, p.kwhAmount, p.timestamp, p.storageCapacity,
    p.chargeLevelPercent, p.sourceType, p.cumulativeCycles,
  ]);
  return keccak256(encoded);
}

async function signDevice(p: MeasurementPacket, device: Wallet): Promise<string> {
  return device.signMessage(getBytes(packetHash(p)));   // EIP-191 prefix applied internally
}

async function signVpp(p: MeasurementPacket, deviceSig: string, vpp: Wallet): Promise<string> {
  const payload = AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes'], [packetHash(p), deviceSig]);
  return vpp.signMessage(getBytes(keccak256(payload)));  // EIP-191 prefix applied internally
}
```

The reference simulator implements the same logic with the same byte output:
- `oracle-simulator/src/edge-device.ts::buildDeviceDigest` + `EdgeDevice.sign`
- `oracle-simulator/src/vpp-cloud.ts::buildVppDigest` + `VppCloud.cosign`

The integration test `test/integration/EndToEnd.t.ts` includes an interop
probe that asserts the simulator's bytes equal the snippet above.

---

## 7. Future versions

| Version | Status      | Change                                                        |
|---------|-------------|---------------------------------------------------------------|
| V0      | active      | Phase 0 — EIP-191 prefix on both digests, plain abi.encode.   |
| V1      | proposed    | EIP-712 typed-data signing (richer wallet UX, DApp-friendly). |
| V2      | speculative | Zero-knowledge attestation (BLS aggregation across VPP nodes).|

A bump in dialect version requires a new contract deployment OR an upgradeable
verifier (V1+ may be opt-in per device record). The contract address is
versioned by deployment; the dialect tag travels in this spec.

---

## 8. Versioning & change-control

- This file is the SINGLE source of truth for the dialect.
- Any change to the digest encoding requires:
  1. A pull request modifying both this file AND the contract in lockstep.
  2. A new dialect tag (`EXERGY_SIGNATURE_DIALECT_V1`, etc.).
  3. An interop probe test demonstrating that all reference implementations
     produce identical bytes for a fixed test vector.
- Implementers are encouraged to commit a recorded test vector
  (input packet, expected packetHash, expected vppPayloadHash) to their own
  test suites so silent drift is impossible.
