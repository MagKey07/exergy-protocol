# VPP Integration Guide — Exergy Protocol Phase 0

**Audience:** Senior backend engineer at a VPP operator integrating their existing solar+battery cloud against the Exergy protocol on Arbitrum Sepolia testnet.

**Goal:** by the end of this guide, your VPP cloud submits signed measurement packets to the protocol, mints `$XRGY` tokens against verified energy in your batteries, and you can read live network state from the deployed contracts.

**Phase 0 status:** all five contracts are deployed and verified on Arbitrum Sepolia. The protocol mints, distributes fees, and rejects malformed packets exactly per the spec. Mainnet launch follows a tier-1 audit (planned Q3-Q4 2026).

---

## Table of contents

1. [What you are connecting](#1-what-you-are-connecting)
2. [Architecture in 60 seconds](#2-architecture-in-60-seconds)
3. [Prerequisites](#3-prerequisites)
4. [Five-step onboarding](#4-five-step-onboarding)
5. [The MeasurementPacket — field-by-field reference](#5-the-measurementpacket--field-by-field-reference)
6. [Dual-signature scheme — exact byte layout](#6-dual-signature-scheme--exact-byte-layout)
7. [Submission — the on-chain call](#7-submission--the-on-chain-call)
8. [Reading network state](#8-reading-network-state)
9. [Errors — every revert reason and what triggers it](#9-errors--every-revert-reason-and-what-triggers-it)
10. [Phase 0 vs production — what is honestly different](#10-phase-0-vs-production--what-is-honestly-different)
11. [Reference SDK](#11-reference-sdk)
12. [Where to get help](#12-where-to-get-help)

---

## 1. What you are connecting

You operate a VPP cloud — a backend service that ingests battery telemetry from a fleet of household devices (Tesla Powerwall, Sonnen, Enphase, custom inverter+battery, whatever your fleet looks like). For each device you already track, at minimum:

- A stable device identifier
- Battery state-of-charge over time
- Battery cumulative cycle counter (for warranty tracking)
- Battery nameplate capacity
- Source type (solar / wind / hybrid)
- Timestamps

That data is enough. The integration is a thin connector that:

1. Reads the existing telemetry stream from your cloud (one call to your internal API).
2. Constructs an Exergy `MeasurementPacket` for each measurement window.
3. Produces two signatures — one from a per-device key, one from your VPP cloud signing key.
4. Submits the dual-signed packet to a single on-chain function on Arbitrum Sepolia.

Each successful submission mints `$XRGY` to your VPP cloud wallet at the current era's rate (1.0 token per kWh in Era 0, halving every 1M tokens minted globally). The protocol pulls a 1% fee from the mint. Everything else stays in your wallet.

**No customer-facing changes are required to integrate.** The token economy is opt-in for your operators. You can run shadow-mode integration parallel to your existing pipeline indefinitely.

---

## 2. Architecture in 60 seconds

Five contracts, all deployed on Arbitrum Sepolia at the addresses below. Four of them are UUPS-upgradeable proxies; XRGYToken is non-upgradeable.

| Contract | Address | Purpose |
|---|---|---|
| **XRGYToken** | `0x8557e39A372FAC1811b2171207B669975B648fDB` | ERC-20 + EIP-2612 permit. Receipt for verified kWh in storage. |
| **OracleRouter** | `0x43F2c96AE8f866C181b4ce97966Bd4e4a36AE2e5` | Receives measurement packets, verifies dual signatures, forwards to engine. |
| **MintingEngine** | `0x223cEf9882f5F7528CCC4521773683B83723B5A4` | Validates Proof-of-Wear, mints tokens, advances eras at halving thresholds. |
| **Settlement** | `0xBaFe8D465F9D7fCab723e41c0bA13D328b2E4C9C` | Pulls 1% fee on each mint, handles peer-to-peer settlement. |
| **ProtocolGovernance** | `0x6444902f410aFd866BDA058d64C596ad4Aa1ad70` | VPP registry, protocol-wide pause, upgrade gate. |

**Network:** Arbitrum Sepolia (chainId `421614`). Public RPC: `https://sepolia-rollup.arbitrum.io/rpc`. Block explorer: `https://sepolia.arbiscan.io/`.

**Live state:** [exergy-dashboard.vercel.app](https://exergy-dashboard.vercel.app) — total supply, floating index, era, recent mints.

You will interact with three contracts during integration:

- **OracleRouter** — `registerDevice` (admin-gated, see §4) + `submitMeasurement` (your hot path).
- **XRGYToken** — `approve(Settlement, MAX)` once + `balanceOf(yourWallet)` for monitoring.
- **MintingEngine** — read-only views: `currentEra()`, `currentMintRateWeiPerKwh()`, `getFloatingIndex()`, `getDeviceCycleState(deviceId)`.

**Settlement** is called automatically by the engine on every mint — you do not call it directly during minting. You may call its `settleEnergy` later if your operators want to redeem tokens against grid bills (see §10).

---

## 3. Prerequisites

### 3.1 Network and gas

- An Arbitrum Sepolia RPC endpoint. The public node above works. For production-grade reliability use Alchemy, QuickNode, or your own.
- A small amount of Sepolia ETH (`~0.01` ETH) on your VPP cloud wallet for gas. Bridge from Ethereum Sepolia using the [Arbitrum bridge](https://bridge.arbitrum.io/) or use a faucet.

### 3.2 VPP cloud signing wallet

A single Ethereum wallet that will:

- Co-sign every measurement packet from your fleet.
- Be the recipient of every minted `$XRGY` token.
- Hold `CHAINLINK_RELAYER_ROLE` on OracleRouter (granted by protocol admin during onboarding — see §4).
- Approve Settlement to skim the 1% mint fee from incoming tokens.

Generate this wallet **once** and protect it. In production, this is an HSM key or a cloud KMS key. In testnet you can use any 32-byte private key. The address must be stable across your fleet — every device's `MeasurementPacket` will be co-signed by this single VPP key.

### 3.3 Device key strategy

Each physical device in your fleet must have a stable Ethereum-compatible secp256k1 keypair. The corresponding 20-byte address (hashed) is registered on-chain at device registration. Subsequent packets from that device must be signed by that key to pass verification.

**Production architecture (recommended):** an ATECC608B or equivalent secure element on the device, generating the keypair inside the chip. The signing operation is an I2C call; the private key bytes never leave the chip. This is what survives audit.

**Testnet shortcut (acceptable for pilot, NOT for production):** derive device keys deterministically from a seed:

```typescript
const devicePrivKey = ethers.keccak256(
  ethers.toUtf8Bytes(`exergy-vpp:${vppLabel}:device-${deviceId}`),
);
```

This makes device keys reproducible across runs and lets you re-sign historical telemetry for backfill testing. Do not ship deterministic keys to mainnet — your fleet's signatures become trivially forgeable.

### 3.4 Telemetry data mapping

Map your existing telemetry fields to the `MeasurementPacket` fields below:

| Your field | MeasurementPacket field | Conversion notes |
|---|---|---|
| Device serial / UUID | `deviceId` | Hash to `bytes32`. Stable per device. |
| Battery state-of-charge delta over window | `kwhAmount` | Convert to 18-decimal fixed-point. 5 kWh = `5n * 10n**18n`. |
| Sample timestamp | `timestamp` | Unix seconds (`uint64`). Within 5 min future / 72 h past of `block.timestamp`. |
| Battery nameplate | `storageCapacity` | 18-decimal fixed-point. 13.5 kWh = `135n * 10n**17n`. |
| State-of-charge percent | `chargeLevelPercent` | `0–100` as `uint8`. |
| Energy source | `sourceType` | `0` solar, `1` wind, `2` hydro, `3` other. |
| Lifetime cycle counter | `cumulativeCycles` | `uint32`. Strictly monotonic. Never reset. |

The protocol does not ingest individual instantaneous readings — it ingests verified _windows_. A typical cadence is one packet per device per 24-hour epoch, summing the net stored kWh over that window. Higher cadence is allowed within Proof-of-Wear constraints (§5.4).

---

## 4. Five-step onboarding

### Step 1: Get `CHAINLINK_RELAYER_ROLE` granted to your VPP cloud wallet

**This is currently the only manual coordination step.** In Phase 0, the protocol admin grants `CHAINLINK_RELAYER_ROLE` to your VPP cloud address one-time. Once granted, your wallet can submit measurements directly. In Phase 1 (post-mainnet), this gate is replaced by a Chainlink External Adapter that runs 3-of-5 oracle consensus + DSO cross-check for every packet — at that point any operator can submit through the adapter without bilateral coordination.

To request the grant on testnet, send your VPP cloud wallet address (the one that will co-sign packets) to the protocol team via Github issue at [`MagKey07/exergy-protocol/issues`](https://github.com/MagKey07/exergy-protocol/issues) or email `info@keyenergy.io`. Turnaround is typically the same day.

The grant is a single transaction on the protocol admin's side:

```solidity
oracleRouter.grantRole(
  keccak256("CHAINLINK_RELAYER_ROLE"),
  yourVppCloudWallet
);
```

Verify the grant on Arbiscan or programmatically:

```typescript
const role = ethers.id("CHAINLINK_RELAYER_ROLE");
const hasRole = await oracleRouter.hasRole(role, yourVppCloudWallet);
// expect: true
```

### Step 2: Register your VPP in ProtocolGovernance

This is also a one-time admin action. The protocol team calls:

```solidity
protocolGovernance.registerVPP(
  bytes32 vppId,           // e.g. ethers.id("vpp:your-network-name")
  address operatorAddress  // your VPP cloud signing wallet
);
```

The `vppId` is a stable identifier you choose — it appears in cross-VPP settlement events. Send your preferred `vppId` string and operator address to the protocol team in the same Github issue / email as step 1.

**Note:** `ProtocolGovernance.registerVPP` is independent of OracleRouter device registration. Both must complete before you can mint.

### Step 3: Register each device in OracleRouter

Once your VPP is registered (step 2), your VPP cloud cannot self-register devices yet — `OracleRouter.registerDevice` is gated by `DEVICE_REGISTRAR_ROLE`, currently held only by the protocol admin. In Phase 0, you submit a list of device registrations to the protocol team along with steps 1+2; the team executes the batch in one transaction.

For each device, you provide:

- `deviceId` (`bytes32`) — stable, e.g. `keccak256(utf8("vpp:your-name:device:0001"))`.
- `vppAddress` (`address`) — your VPP cloud signing wallet from step 1.
- `devicePubKeyHash` (`bytes32`) — see below.

**Computing `devicePubKeyHash` correctly.** This is the single highest-friction detail in the whole integration. The contract stores and verifies against the hash of the recovered 20-byte Ethereum address — NOT the hash of the 64-byte uncompressed public key:

```typescript
import { ethers } from "ethers";

const devicePubKeyHash = ethers.solidityPackedKeccak256(
  ["address"],
  [deviceWallet.address],
);
```

Equivalent in Solidity terms: `keccak256(abi.encodePacked(deviceAddress))`. If you instead hash the raw public key bytes, every packet from that device will revert with `InvalidDeviceSignature` and you will spend two days debugging.

In Phase 1 (Q3-Q4 2026), self-service device registration via signed off-chain claims is on the roadmap — your VPP cloud will be able to register devices in batches without admin involvement.

### Step 4: Approve Settlement to take the 1% fee

Once per VPP cloud wallet, on the `XRGYToken` contract:

```typescript
const MAX = (1n << 256n) - 1n; // ethers.MaxUint256
await xrgyToken.connect(vppCloudWallet).approve(SETTLEMENT_ADDRESS, MAX);
```

This authorizes Settlement to pull the 1% protocol fee from your VPP cloud's `$XRGY` balance immediately after each mint. Without this approval, the fee call inside `MintingEngine` is wrapped in a `try/catch` on Phase 0 and silently no-ops — your mint succeeds but the fee is never collected. **On mainnet this becomes a hard revert.** Set the approval before your first mint.

### Step 5: Submit your first measurement packet

You are now ready to mint. Continue to §5 for packet construction, §6 for signing, §7 for submission. The reference SDK in §11 wraps the whole flow into three function calls.

---

## 5. The `MeasurementPacket` — field-by-field reference

The exact struct from `IOracleRouter.sol`:

```solidity
struct MeasurementPacket {
    bytes32 deviceId;
    uint256 kwhAmount;
    uint64  timestamp;
    uint256 storageCapacity;
    uint8   chargeLevelPercent;
    uint8   sourceType;
    uint32  cumulativeCycles;
}
```

### 5.1 `deviceId` (`bytes32`)

Must match a previously-registered device. Any 32-byte value is acceptable; a stable, deterministic derivation from your internal device identifier is recommended:

```typescript
const deviceId = ethers.id(`vpp:your-network:device:${internalSerial}`);
// equivalent to: keccak256(toUtf8Bytes(...))
```

### 5.2 `kwhAmount` (`uint256`, 18-decimal fixed-point)

The kWh stored over this window. 18-decimal fixed-point: 1 kWh = `10n**18n`. Examples:

```typescript
const fivePointTwoKwh = ethers.parseUnits("5.2", 18); // 5_200_000_000_000_000_000n
```

**Precision tip.** Going through `Number` with `* 1e18` loses precision past 6 decimal places. For high-precision needs (sub-watt-hour granularity is rare but not unheard of), do the multiplication in integer space:

```typescript
function toWadKwh(kwh: number): bigint {
  // Two-stage multiplication preserves more precision than (kwh * 1e18)
  return BigInt(Math.round(kwh * 1e9)) * 1_000_000_000n;
}
```

### 5.3 `timestamp` (`uint64`, unix seconds)

When the BMS captured this measurement. Hard window enforced by the contract (`OracleRouter.sol`, time check at submission):

- **Maximum future drift:** `block.timestamp + 5 minutes`. Above this, reverts with `TimestampOutOfWindow()`.
- **Maximum backdate:** `block.timestamp - 72 hours`. Below this, also reverts.

Submit packets soon after measurement. A 24-hour epoch cadence with 1-2 hour latency is well within window.

### 5.4 `storageCapacity` (`uint256`, 18-decimal fixed-point)

The device's nameplate battery capacity. 18-decimal. Example for a 13.5 kWh Powerwall:

```typescript
const powerwallCapacity = ethers.parseUnits("13.5", 18);
```

**Constraint:** the contract refuses to accept a `storageCapacity` smaller than what was previously recorded for this device (`CapacityShrinkRejected`). If a device is replaced with a smaller battery, deactivate the old `deviceId` and register a new one.

**Constraint:** for any single packet, `kwhAmount` must be `≤ storageCapacity * cyclesDelta` where `cyclesDelta` is the increment of `cumulativeCycles` since the last accepted packet. This is the energy/capacity sanity check (`EnergyExceedsCapacity`). For the first packet on a fresh device, `cyclesDelta` is treated as `cumulativeCycles` itself (initial bootstrap).

### 5.5 `chargeLevelPercent` (`uint8`, 0–100)

State-of-charge at the sample time. The contract does not currently use this for verification — it is recorded for off-chain analytics and will be consumed by the Phase 1 dispute mechanism. Set accurately.

### 5.6 `sourceType` (`uint8`)

Energy source enum:

| Value | Meaning |
|---|---|
| `0` | Solar |
| `1` | Wind |
| `2` | Hydro |
| `3` | Other |

Multi-source devices: report the dominant source for the window. The protocol does not currently weight differently by source type — this is recorded for reporting and future market segmentation.

### 5.7 `cumulativeCycles` (`uint32`)

The lifetime monotonic cycle counter from device firmware. Strictly increasing across a device's lifetime. The protocol enforces three Proof-of-Wear constraints:

1. **Monotonicity.** `cumulativeCycles` must be `≥` the last accepted value for this device. Going backwards reverts with `CycleCounterRegression`.
2. **Per-epoch budget.** Within any epoch, `cumulativeCycles` may increment by at most `2 * (epochsDelta + 1)` cycles, where `epochsDelta` is the number of full epochs since the last accepted packet. A device submitting two packets within the same epoch (epochsDelta = 0) gets a budget of 2 cycles; over a 5-day gap it gets `2 * 6 = 12` cycles. Going over this reverts with `ProofOfWearViolation`. The constant `MAX_CYCLES_PER_EPOCH = 2` is a hard-coded `public constant` — no governance override.
3. **Energy/cycle/capacity sanity.** Already covered in §5.4.

If your battery firmware doesn't expose a cycle counter, you can derive one from energy throughput: `cumulativeCycles ≈ floor(lifetime_kwh_throughput / nameplate_capacity)`. Just be consistent across packets — divergence between off-chain and on-chain rollups will trigger anomaly rejection.

---

## 6. Dual-signature scheme — exact byte layout

Every packet is signed by two keys: the **device key** (proves the measurement came from a specific physical battery) and the **VPP cloud key** (proves your VPP authorizes including this device under your operator account). The contract verifies both before forwarding to the engine.

### 6.1 Device signature

**What is signed.** The packet hash:

```typescript
import { ethers } from "ethers";

const PACKET_TUPLE = "tuple(" +
  "bytes32 deviceId," +
  "uint256 kwhAmount," +
  "uint64 timestamp," +
  "uint256 storageCapacity," +
  "uint8 chargeLevelPercent," +
  "uint8 sourceType," +
  "uint32 cumulativeCycles" +
")";

function packetHash(packet: MeasurementPacket): string {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    [PACKET_TUPLE],
    [[
      packet.deviceId,
      packet.kwhAmount,
      packet.timestamp,
      packet.storageCapacity,
      packet.chargeLevelPercent,
      packet.sourceType,
      packet.cumulativeCycles,
    ]],
  );
  return ethers.keccak256(encoded);
}
```

This is `abi.encode` — full 32-byte zero-padding per field — NOT `abi.encodePacked`. Field order must exactly match the struct. Any swap or width change breaks recovery.

**How it is signed.** Apply EIP-191 prefix via ethers `signMessage`:

```typescript
const deviceSignature = await deviceWallet.signMessage(
  ethers.getBytes(packetHash(packet))
);
```

This produces a 65-byte `(r, s, v)` ECDSA signature over `keccak256("\x19Ethereum Signed Message:\n32" || packetHash)`. The contract uses OpenZeppelin's `MessageHashUtils.toEthSignedMessageHash(packetHash).recover(deviceSignature)`, which is exactly this prefix.

### 6.2 VPP co-signature

**What is signed.** The hash of `(packetHash, deviceSignature)`:

```typescript
function vppDigest(packet: MeasurementPacket, deviceSignature: string): string {
  const inner = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bytes"],
    [packetHash(packet), deviceSignature],
  );
  return ethers.keccak256(inner);
}
```

**Critical:** the inner encoding takes exactly two fields — the `bytes32` packet hash and the raw `bytes` device signature. **The VPP address is NOT included.** An older spec mistakenly included `vppAddress` as a third field; that older encoding fails on-chain recovery. Use the two-field version above.

**How it is signed.** Same EIP-191 prefix:

```typescript
const vppSignature = await vppCloudWallet.signMessage(
  ethers.getBytes(vppDigest(packet, deviceSignature))
);
```

### 6.3 Why two signatures (the Anti-Simulation Lock)

A single signature could be replayed or generated by a fake VPP simulating telemetry. Requiring both signatures from independent keys means an attacker would need to compromise (a) the on-device secure element AND (b) the VPP cloud key simultaneously to forge a packet. Combined with the Proof-of-Wear cycle budget, the only practical way to produce mintable packets is to actually have a battery storing energy — which is what the protocol intends to reward.

The contract logic in `OracleRouter.submitMeasurement`:

1. Compute `packetHash = keccak256(abi.encode(packet))`.
2. Recover `recoveredDevice` from `deviceSignature` against the EIP-191-prefixed packet hash. Verify `keccak256(abi.encodePacked(recoveredDevice)) == registry[deviceId].devicePubKeyHash`.
3. Recover `recoveredVPP` from `vppSignature` against the EIP-191-prefixed VPP digest. Verify `recoveredVPP == registry[deviceId].vppAddress`.
4. Reject if `_processed[packetHash]` is already true (replay protection).
5. Forward to `MintingEngine.commitVerifiedEnergy`.

---

## 7. Submission — the on-chain call

### 7.1 The function

```solidity
function submitMeasurement(
    MeasurementPacket calldata packet,
    bytes calldata deviceSignature,
    bytes calldata vppSignature
) external whenNotPaused onlyRole(CHAINLINK_RELAYER_ROLE)
```

Caller must hold `CHAINLINK_RELAYER_ROLE` (granted in §4 step 1). The contract is not paused under normal operation — `whenNotPaused` is a circuit-breaker for emergencies.

### 7.2 Calling it from your VPP cloud

```typescript
import { ethers } from "ethers";
import { ORACLE_ROUTER_ADDRESS, ORACLE_ROUTER_ABI } from "@your-org/exergy-sdk";

const provider = new ethers.JsonRpcProvider(ARBITRUM_SEPOLIA_RPC_URL);
const vppCloudWallet = new ethers.Wallet(VPP_CLOUD_PRIVATE_KEY, provider);
const oracleRouter = new ethers.Contract(
  ORACLE_ROUTER_ADDRESS,
  ORACLE_ROUTER_ABI,
  vppCloudWallet,
);

const tx = await oracleRouter.submitMeasurement(
  packet,
  deviceSignature,
  vppSignature,
  { gasLimit: 600_000n }, // see §7.3 — DO NOT omit
);
const receipt = await tx.wait();
```

### 7.3 Why `gasLimit: 600_000n` is mandatory

`MintingEngine.commitVerifiedEnergy` calls `Settlement.collectMintingFee` inside a Solidity `try/catch`. Under [EIP-150](https://eips.ethereum.org/EIPS/eip-150), only 63/64 of the remaining gas is forwarded to the inner call. If the outer `estimateGas` is tight, the 63/64 budget runs out inside `Settlement` — the inner call OOG-reverts, and `try/catch` silently swallows the failure. Result: your mint succeeds but the 1% fee is never collected.

Passing an explicit `gasLimit: 600_000n` (or higher) gives the inner call enough budget. This is a Phase 0 workaround. In Phase 1 the `try/catch` is replaced with a hard requirement that returns success/failure properly.

If you let your library auto-estimate gas without padding, expect intermittent silent fee skips on testnet.

### 7.4 What a successful submission emits

In one transaction, three events fire that you should index:

1. **`OracleRouter.MeasurementVerified(deviceId, vppAddress, kwhAmount, timestamp, epoch)`** — packet passed dual-sig verification. Useful for UI feedback ("packet accepted").
2. **`MintingEngine.EnergyMinted(deviceId, vppAddress, kwhAmount, tokensMinted, epoch, era)`** — tokens were minted to your VPP cloud wallet. `tokensMinted = (kwhAmount * rate) / 1e18`. In Era 0, `tokensMinted == kwhAmount`.
3. **`XRGYToken.Transfer(0x0, vppAddress, tokensMinted)`** — the standard ERC-20 mint event. Your wallet's `$XRGY` balance is now higher by `tokensMinted - fee`.

Optionally a `HalvingTriggered(newEra, newRateNumerator, totalSupplyAtHalving)` event fires if your mint crosses an era boundary.

If the dual-signature check or Proof-of-Wear check fails, the transaction reverts with one of the errors in §9.

### 7.5 Recommended cadence

- **One packet per device per 24-hour epoch** is the canonical rhythm. Aligns with `EPOCH_DURATION = 1 days` on the contract.
- Higher cadence is allowed but bounded by the Proof-of-Wear cycle budget. Two packets per device per epoch is the maximum unless cycle deltas justify more.
- Lower cadence (e.g. weekly batched) is also allowed — `epochsDelta` simply scales the cycle budget proportionally.
- Submit shortly after the BMS sample. The 5-min future / 72-h past window leaves comfortable room for batching and retries.

---

## 8. Reading network state

Useful view functions for your VPP cloud and your operations dashboard:

```solidity
// MintingEngine — mint mechanics
function currentEra() external view returns (uint256);
function currentMintRateWeiPerKwh() external view returns (uint256);  // = 1e18 >> currentEra
function getFloatingIndex() external view returns (uint256);          // (totalVerifiedEnergyInStorage * 1e18) / totalSupply
function currentEpoch() external view returns (uint256);              // (block.timestamp - genesisTimestamp) / 86400
function totalVerifiedEnergyInStorage() external view returns (uint256);
function totalTokensMinted() external view returns (uint256);
function halvingThreshold() external view returns (uint256);
function getEpochData(uint256 epoch) external view returns (EpochData);

// Per-device Proof-of-Wear state — useful for diagnosing rejections before submitting
function getDeviceCycleState(bytes32 deviceId) external view returns (DeviceCycleState);

// XRGYToken
function balanceOf(address account) external view returns (uint256);  // your minted balance
function totalSupply() external view returns (uint256);

// OracleRouter — lookup whether a packet was already submitted
function isMeasurementProcessed(bytes32 packetHash) external view returns (bool);

// Settlement — fee config (operator visibility)
function mintingFeeBps() external view returns (uint16);  // currently 100 = 1%
```

For a one-stop public view of network state without RPC calls of your own, use the dashboard at [exergy-dashboard.vercel.app](https://exergy-dashboard.vercel.app).

For dispute and audit trails, every accepted packet emits `MeasurementVerified` and `EnergyMinted`. Every rejected packet emits `AnomalyRejected(deviceId, vppAddress, kwhAmount, cumulativeCycles, reason)` BEFORE the revert, so you can index rejection reasons even though the transaction failed (the events from a reverted transaction are not persisted, but `AnomalyRejected` is emitted in the path that completes successfully — the rejection categories that emit it are documented next).

---

## 9. Errors — every revert reason and what triggers it

### 9.1 OracleRouter

| Revert | Trigger | Fix |
|---|---|---|
| `DeviceAlreadyRegistered(bytes32)` | `registerDevice` for a deviceId already in the registry. | Use a fresh deviceId, or `setDeviceActive(deviceId, true)` to reactivate an existing one. |
| `DeviceNotRegistered(bytes32)` | `submitMeasurement` for an unregistered deviceId. | Complete §4 step 3 for this device first. |
| `DeviceInactive(bytes32)` | Submitting from a device flagged `active = false`. | Contact protocol team to reactivate, or use a different device. |
| `InvalidDeviceSignature()` | Recovered address from `deviceSignature` doesn't match registered `devicePubKeyHash`. | Verify `devicePubKeyHash = keccak256(abi.encodePacked(address))`, NOT pubkey bytes. Verify the signing wallet matches what you registered. |
| `InvalidVPPSignature()` | Recovered address from `vppSignature` doesn't match registered `vppAddress`. | Verify the VPP digest is `keccak256(abi.encode(packetHash::bytes32, deviceSignature::bytes))` — exactly two fields, no `vppAddress`. |
| `TimestampOutOfWindow()` | `packet.timestamp` is more than 5 min in the future or 72 h in the past relative to `block.timestamp`. | Sync your clock. If batch-submitting historical data, the 72 h backstop is hard. |
| `DuplicateMeasurement(bytes32 packetHash)` | The same packetHash was already submitted. | Each packet must be unique — change `timestamp` or `cumulativeCycles` so the hash differs. |
| `ZeroAddress()` | `registerDevice` with zero `vppAddress`, or other admin setters with zero address. | Pass a valid address. |
| `MintingEngineAlreadySet()` | Calling `setMintingEngine` after wiring (one-shot setter). | Not encountered during integration; admin-only. |
| `AccessControlUnauthorizedAccount(address, bytes32)` | Caller does not hold `CHAINLINK_RELAYER_ROLE`. | Complete §4 step 1 — request role grant. |

### 9.2 MintingEngine

| Revert | Trigger | Fix |
|---|---|---|
| `NotOracleRouter()` | Calling `commitVerifiedEnergy` directly. | Don't. Always go through OracleRouter. |
| `MintAmountZero()` | `(kwhAmount * rate) / 1e18 == 0`. | At Era ≥ 64 the rate is 0; before that, ensure `kwhAmount * rate >= 1e18`. |
| `EpochAlreadySealed(uint256)` | Submitting into an epoch that an admin sealed. | Admin-only state; rare in normal operation. Wait for the next epoch. |
| `ProofOfWearViolation(uint256 cyclesDelta, uint256 maxAllowed)` | `cyclesDelta > 2 * (epochsDelta + 1)`. | Reduce `cumulativeCycles` increment per packet, or wait additional epochs to accumulate budget. |
| `CycleCounterRegression(uint32 prior, uint32 attested)` | `cumulativeCycles` decreased. | Don't reset device firmware counters. If a device was replaced, register as a new deviceId. |
| `EnergyExceedsCapacity(uint256 claimed, uint256 max)` | `kwhAmount > storageCapacity * cyclesDelta`. | Ensure `kwhAmount` for the window doesn't exceed what `cyclesDelta` cycles at `storageCapacity` could physically deliver. For first packet, `cyclesDelta = cumulativeCycles`. |
| `CapacityShrinkRejected(uint256 priorCapacity, uint256 attestedCapacity)` | New `storageCapacity` is smaller than what was previously accepted for this device. | Same as above — replaced battery → new deviceId. |

For each of `ProofOfWearViolation`, `CycleCounterRegression`, `EnergyExceedsCapacity`, `CapacityShrinkRejected`, the contract first emits `AnomalyRejected(deviceId, vppAddress, kwhAmount, cumulativeCycles, reason)` and then reverts. Phase 0 caveat: events from reverted transactions are not persisted by Ethereum, so to see these reasons you need to call `eth_call` (simulate) before submitting, not `eth_sendTransaction`.

### 9.3 Settlement

You don't call Settlement during minting, but be aware:

| Revert | Trigger |
|---|---|
| `NotMintingEngine()` | Calling `collectMintingFee` directly. |
| `AmountZero()` | `settleEnergy` or `crossVPPSettle` with zero `tokenAmount`. |
| `FeeBpsTooHigh(uint256)` | Admin tried to set fee > 10%. Capped at 1000 bps. |

ERC-20 allowance/balance failures inside `safeTransferFrom` revert with the standard OZ ERC-20 errors (`ERC20InsufficientAllowance`, `ERC20InsufficientBalance`).

---

## 10. Phase 0 vs production — what is honestly different

The protocol is fully working on Arbitrum Sepolia. It is not yet on mainnet. Here is what currently differs from the eventual production design — disclosed up front so your tech and legal teams know what they're signing up for in a pilot:

### 10.1 Permissioned submission

- **Now:** `submitMeasurement` is gated by `CHAINLINK_RELAYER_ROLE`. Currently held by the protocol admin EOA. Onboarding a VPP requires manual role grant (§4 step 1).
- **Production:** the role is held exclusively by a Chainlink External Adapter that runs 3-of-5 oracle consensus + DSO cross-check on every packet. Any operator whose data passes consensus is relayed automatically — no bilateral coordination required.

### 10.2 Permissioned device registration

- **Now:** `registerDevice` is `DEVICE_REGISTRAR_ROLE`-gated, currently admin-only. VPPs submit a list of devices to the protocol team for batch registration.
- **Production:** self-service registration via signed off-chain claims, batched on-chain by the VPP itself. Roadmap Q3-Q4 2026.

### 10.3 Soft fee collection

- **Now:** `MintingEngine` wraps `Settlement.collectMintingFee` in `try/catch`. If your VPP cloud has not approved Settlement, the fee is silently skipped and your mint succeeds.
- **Production:** the `try/catch` is replaced with a hard requirement. A mint that cannot collect its fee reverts. Your VPP cloud must approve Settlement before mainnet.

### 10.4 Single deployer holds all admin roles

- **Now:** the deployer EOA `0x92a82...A91e` holds `DEFAULT_ADMIN_ROLE`, `UPGRADER_ROLE`, `PAUSER_ROLE`, `DEVICE_REGISTRAR_ROLE`, `CHAINLINK_RELAYER_ROLE`, `EPOCH_SEALER_ROLE`, `TEST_HOOK_ROLE`, and `FEE_MANAGER_ROLE` across all five contracts. Token ownership is also held by the deployer.
- **Production:** roles distributed across a Gnosis Safe multisig (admin), a separate audit/governance multisig (upgrader), the Chainlink Adapter wallet (relayer only), and dedicated registrar accounts. `TEST_HOOK_ROLE` is permanently revoked. Token ownership is renounced after final wiring. This is part of the audit deliverable.

### 10.5 Test-hook role active

- **Now:** `TEST_HOOK_ROLE` on MintingEngine permits the admin to override `totalVerifiedEnergyInStorage`, `currentEra`, `halvingThreshold`, `genesisTimestamp` — for testnet diagnostics and reset. State you read on testnet may have been admin-overridden.
- **Production:** the role is revoked; the override functions revert.

### 10.6 Identical fee receivers

- **Now:** all four fee shares (treasury 40%, team 20%, ecosystem 25%, insurance 15%) go to the deployer address.
- **Production:** four distinct wallets per the spec, configurable by the FEE_MANAGER multisig.

### 10.7 No real fiat off-ramp

- **Now:** `$XRGY` exists on Arbitrum Sepolia. There is no DEX listing, no centralized exchange, no fiat off-ramp. Trades are between accounts on testnet.
- **Production:** post-audit and mainnet launch, `$XRGY` will be listed on Uniswap (Arbitrum One) and at least one centralized exchange. Operators will be able to sell minted tokens for fiat through standard crypto rails.

### 10.8 No subgraph

- **Now:** event indexing requires direct RPC calls (chunked because public RPCs cap `eth_getLogs` at 50,000 blocks).
- **Production:** a hosted subgraph at `thegraph.com` indexes all events with low-latency GraphQL queries.

### 10.9 What does work today and is honest

- All five contracts deployed and verified on Arbiscan.
- Dual-signature verification, Proof-of-Wear, mint formula, halving math — all running exactly per spec.
- Token transfers, EIP-2612 permit, fee collection (when approve is set), peer-to-peer settlement via `Settlement.settleEnergy`, cross-VPP settlement via `Settlement.crossVPPSettle` — all working.
- Live operator-facing dashboard reading state in real time.
- Smoke-test VPP currently minting with synthetic devices to keep the network warm; available as a reference.

---

## 11. Reference SDK

A minimal TypeScript SDK lives in `MVP/sdk/` (~150 lines, `ethers v6`, no other runtime dependencies). It packages packet construction, dual-signature production, and submission with the right gas limit. See `MVP/sdk/README.md` for installation and a full mint example.

The three primitives:

```typescript
import {
  buildPacketHash,
  signPacket,
  submitMeasurement,
} from "@exergy/vpp-connector-sdk";

// 1. Build a packet from your telemetry
const packet = {
  deviceId: ethers.id("vpp:my-network:device:0001"),
  kwhAmount: ethers.parseUnits("5.2", 18),
  timestamp: BigInt(Math.floor(Date.now() / 1000)),
  storageCapacity: ethers.parseUnits("13.5", 18),
  chargeLevelPercent: 87,
  sourceType: 0, // solar
  cumulativeCycles: 142,
};

// 2. Produce both signatures
const { deviceSignature, vppSignature } = await signPacket({
  packet,
  deviceWallet,
  vppCloudWallet,
});

// 3. Submit on-chain
const receipt = await submitMeasurement({
  packet,
  deviceSignature,
  vppSignature,
  oracleRouterAddress: ORACLE_ROUTER_ADDRESS,
  signer: vppCloudWallet,
});

console.log("Minted in block", receipt.blockNumber);
```

The full module source is intentionally short and copy-pasteable — you may either depend on the published package or copy the relevant files into your codebase. Both approaches are supported.

For a complete worked example that covers registration + approval + first mint end-to-end against Arbitrum Sepolia, see `MVP/sdk/examples/submit-one-packet.ts`.

---

## 12. Where to get help

- **Bugs and questions in the integration:** [github.com/MagKey07/exergy-protocol/issues](https://github.com/MagKey07/exergy-protocol/issues). Tag with `vpp-integration`.
- **Role grants and pilot coordination:** `info@keyenergy.io`. Include your VPP cloud wallet address, preferred `vppId` string, and a list of device labels you want pre-registered.
- **Live network state:** [exergy-dashboard.vercel.app](https://exergy-dashboard.vercel.app).
- **Contract source for audit:** [github.com/MagKey07/exergy-protocol/tree/main/MVP/contracts](https://github.com/MagKey07/exergy-protocol/tree/main/MVP/contracts). MIT licensed.
- **Smoke simulator (working reference for the full pipeline):** [github.com/MagKey07/exergy-protocol/tree/main/MVP/oracle-simulator](https://github.com/MagKey07/exergy-protocol/tree/main/MVP/oracle-simulator).
- **Economic Brief** (the broader "why integrate" document): [docs/outreach/Economic_Brief_for_VPP_Operators.md](outreach/Economic_Brief_for_VPP_Operators.md).

---

## Appendix A — minimum viable connector flow

For an engineer who wants the absolute minimum path from "nothing" to "first mint on Sepolia":

1. Generate a VPP cloud wallet. Fund with 0.01 Sepolia ETH on Arbitrum.
2. Open a Github issue requesting `CHAINLINK_RELAYER_ROLE` grant + `ProtocolGovernance.registerVPP` for your wallet, and submit a list of 1-3 test device labels for registration. Wait for confirmation (same-day).
3. Send `XRGYToken.approve(0xBaFe...4C9C, MaxUint256)` from your VPP cloud wallet.
4. For one of your registered devices, generate a deterministic device key (testnet-only — see §3.3): `deviceKey = keccak256(utf8("exergy-vpp:my-name:device-0001"))`.
5. Build a packet: 1 kWh, current timestamp, your registered storageCapacity, cumulativeCycles = 1, sourceType = 0.
6. Sign with the device key (EIP-191 over `keccak256(abi.encode(packet))`), then sign with the VPP cloud key (EIP-191 over `keccak256(abi.encode(packetHash, deviceSignature))`).
7. Call `OracleRouter.submitMeasurement(packet, deviceSignature, vppSignature, { gasLimit: 600_000n })`.
8. Confirm in Arbiscan: your VPP cloud wallet's `$XRGY` balance is now `0.99` (1 token minted, 1% fee skimmed).

Total integration work for an engineer who has read this guide: approximately one engineering day to get a working pilot connector running against shadow telemetry.

---

*Last updated: 2026-05-10. Phase 0 testnet. Mainnet target: Q4 2026 post-audit.*
