# Exergy Oracle Simulator

Mock oracle pipeline for the Exergy Protocol MVP (Phase 0, Arbitrum Sepolia testnet).

> Replaces the real **Battery BMS → Edge (Pi+HSM) → VPP Cloud → OracleRouter** chain in software so the testnet can be exercised end-to-end before hardware integration with Leigh's VPP (Phase 1).

Reference architecture: `Exergy/01_Pitch/Technical_Blueprint.md` §3 (Oracle Pipeline) and §4 (IoT Hardware).

---

## What it does

```
+-----------+     +--------------+     +-------------+     +---------------+
| BatterySim| --> | EdgeDevice   | --> | VppCloud    | --> | OracleRouter  |
| (BMS data)|     | (HSM signs) |     | (VPP signs) |     | (Arbitrum L2) |
+-----------+     +--------------+     +-------------+     +---------------+
```

1. **BatterySim** generates realistic telemetry (solar bell-curve / wind AR(1) / hydro / other, real cycle accounting, household demand curve).
2. **EdgeDevice** computes `keccak256(abi.encode(packet))`, applies EIP-191 prefix, signs with the device's ECDSA key (mock HSM).
3. **VppCloud** verifies the device signature against the registered signer, then co-signs a digest binding `(deviceDigest, deviceSignature, vppAddress)`.
4. **Submitter** pushes the dual-signed packet to `OracleRouter.submitMeasurement(...)` on Arbitrum Sepolia. Retries transient RPC errors. Honours `DRY_RUN=1`.

---

## Install

```bash
cd Exergy/MVP/oracle-simulator
npm install      # NOT run by the build agent — install when you're ready
cp .env.example .env
$EDITOR .env     # fill RPC URL, OracleRouter address, submitter key
```

Node 20+ required (uses bigint, ES2022 features).

---

## Environment variables

| Var | Purpose | Required |
|---|---|---|
| `ARBITRUM_SEPOLIA_RPC_URL` | RPC endpoint for tx submission | yes (skip for offline mode) |
| `ARBITRUM_SEPOLIA_CHAIN_ID` | Sanity check, defaults to 421614 | no |
| `ORACLE_ROUTER_ADDRESS` | Deployed OracleRouter proxy address | yes (skip for offline mode) |
| `SUBMITTER_PRIVATE_KEY` | Wallet that pays gas to call OracleRouter | yes (skip for offline mode) |
| `VPP_CLOUD_PRIVATE_KEY` | Off-chain ECDSA key the VPP cloud signs with. Defaults to `SUBMITTER_PRIVATE_KEY` | no |
| `DEVICE_PRIVATE_KEY` | Force a specific device key for `single-packet` (otherwise derived deterministically from `--device <label>`) | no |
| `LOG_LEVEL` | `error` \| `warn` \| `info` \| `debug` (default `info`) | no |
| `LOG_FORMAT` | `pretty` (default) or `json` | no |
| `DRY_RUN` | `1` to skip on-chain submission (signatures still built and logged) | no |
| `SUBMIT_MAX_RETRIES` | default `3` | no |
| `SUBMIT_RETRY_BACKOFF_MS` | default `1500` | no |

---

## CLI commands

### Continuous fleet simulation

```bash
npx ts-node src/index.ts simulate-vpp \
  --vpp vpp-tx \
  --devices 5 \
  --duration 24 \
  --rate 2 \
  --source solar \
  --latitude 31 \
  --tz -6 \
  --capacity 13.5
```

Runs 24 simulated hours at 2 packets/hour/device. Each device emits BMS readings, the edge device signs, the VPP cloud co-signs, and (if `ORACLE_ROUTER_ADDRESS` is set) packets are submitted on-chain.

### Single-packet smoke test

```bash
npx ts-node src/index.ts single-packet \
  --device vpp-tx:device-000 \
  --vpp vpp-tx \
  --kwh 2.5 \
  --source solar
```

### Register a device on-chain (owner-only)

```bash
npx ts-node src/index.ts register-device \
  --device vpp-tx:device-000 \
  --vpp vpp-tx
```

Calls `OracleRouter.registerDevice(deviceId, vppAddress, pubKeyHash)`. Will revert if the submitter wallet is not the contract owner.

### Three-region fleet demo (24h, attacker injected)

```bash
npx ts-node scripts/demo-vpp-fleet.ts
```

Spins up `vpp-tx` (Texas solar), `vpp-be` (Berlin wind), `vpp-au` (Sydney solar), runs 24h of simulated time, and uses `vpp-tx:device-000` as an attacker reporting impossible energy (so contract-level rejection paths can be exercised).

---

## Identity model

To make integration with the smart-contracts agent easier, the simulator derives **deterministic** identities from string labels:

| Label | Becomes |
|---|---|
| `vpp-tx` (VPP label) | private key = keccak256("exergy-sim:vpp:vpp-tx"), address derived from it |
| `vpp-tx:device-000` (device label) | private key = keccak256("exergy-sim:vpp-tx:device-000"), deviceId = keccak256("exergy-device:vpp-tx:device-000") |

So the smart-contracts agent can pre-register the same fleet by label, without coordinating actual key bytes. Same labels → same on-chain identities, every run.

---

## Signature scheme

The device signs `keccak256(abi.encode(deviceId, kwhAmount, timestamp, storageCapacity, chargeLevelPercent, sourceType, cumulativeCycles))` with EIP-191 prefixing applied (matches `ethers.Wallet.signMessage` and OpenZeppelin's `MessageHashUtils.toEthSignedMessageHash`).

The VPP cloud signs `keccak256(abi.encode(deviceDigest, deviceSignature, vppAddress))` — same EIP-191 prefix.

If the smart-contracts agent prefers raw-digest recovery (no EIP-191), see `src/edge-device.ts::DEVICE_DIGEST_RAW` — flip `verifyMessage` → `recoverAddress(digest, sig)` in `src/vpp-cloud.ts` to mirror.

ABI types in `src/edge-device.ts::PACKET_ABI_TYPES` MUST stay in lockstep with `OracleRouter.sol` — same order, same widths.

---

## Anti-cheating / anomaly handling

The simulator can be put in `attackerMode` (`--attacker-device` flag, or first device of `vpp-tx` in the demo). When active, the device reports kWh exceeding `capacity * (cycles + 1)`. The simulator logs the anomaly but still emits + signs the packet so the on-chain rejection path is exercised. Real Proof-of-Wear enforcement happens in OracleRouter / MintingEngine.

---

## Files

```
oracle-simulator/
├── package.json
├── tsconfig.json
├── .env.example
├── README.md
├── src/
│   ├── types.ts              # shared interfaces (MeasurementPacket etc.)
│   ├── logger.ts             # winston pretty/json logger
│   ├── keypair.ts            # ECDSA key derivation, deterministic fleet
│   ├── battery-sim.ts        # solar/wind/hydro profiles, cycle accounting
│   ├── edge-device.ts        # device-side signer + canonical digest
│   ├── vpp-cloud.ts          # VPP-side validator + co-signer
│   ├── oracle-router.abi.ts  # minimal ABI for off-chain calls
│   ├── submitter.ts          # ethers contract wrapper, retry logic
│   └── index.ts              # commander CLI entry point
└── scripts/
    └── demo-vpp-fleet.ts     # 3-region 24h fleet demo
```
