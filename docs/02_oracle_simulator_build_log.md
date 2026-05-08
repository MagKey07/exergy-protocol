# 02 — Oracle Simulator Build Log

**Date:** 2026-05-08
**Author:** Turpal (Consigliere agent)
**Phase:** MVP Phase 0 (testnet)
**Output:** `Exergy/MVP/oracle-simulator/`

---

## Context

Built the off-chain mock for the Exergy oracle pipeline so the Phase 0 testnet flow can be exercised end-to-end (simulated kWh → token mint visible on dashboard) before hardware integration with Leigh's VPP in Phase 1. Reference: `Exergy/01_Pitch/Technical_Blueprint.md` §3 (Oracle Pipeline) and §4 (IoT Hardware).

The simulator covers the entire **Battery BMS → Edge Device (Pi+HSM) → VPP Cloud → OracleRouter** chain in software. Real hardware (BYD/Sonnen/Tesla/Huawei BMS over Modbus, ATECC608B HSM for device signing, MQTT/TLS 1.3 to VPP cloud, HTTPS to Chainlink External Adapter) is replaced with reproducible Node.js modules that produce the same dual-signed `MeasurementPacket` the on-chain `OracleRouter.submitMeasurement(...)` expects.

---

## Files created

| File | LOC (approx) | Purpose |
|---|---:|---|
| `package.json` | 36 | npm metadata, deps (ethers ^6, dotenv, commander, winston, typescript, ts-node) |
| `tsconfig.json` | 31 | strict TS config (`strict`, `noImplicitAny`, `noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`) |
| `.env.example` | 34 | template for runtime configuration |
| `.gitignore` | 6 | excludes node_modules, dist, .env |
| `README.md` | 165 | usage, env vars, CLI examples, identity model |
| `src/types.ts` | 137 | `BmsReading`, `SignedDevicePacket`, `DualSignedPacket` (= `MeasurementPacket`), `SourceType` enum, `BatterySimConfig`, anomaly types |
| `src/logger.ts` | 41 | winston pretty/json modes, child loggers per component |
| `src/keypair.ts` | 102 | ECDSA secp256k1 keypair management — `fromPrivateKey`, `fromSeed` (deterministic), `random`, `deviceFleet`, `deviceIdFromLabel`, pubKeyHash derivation |
| `src/battery-sim.ts` | 211 | Realistic telemetry: solar bell-curve with latitude-dependent daylight and cloud walk; wind AR(1) noise; hydro near-constant; household demand bumps; cycle accounting via discharge throughput; anomaly hooks (`attackerMode`) |
| `src/edge-device.ts` | 92 | `EdgeDevice.sign(reading)` produces 65-byte EIP-191 ECDSA signature over canonical `abi.encode` digest; exports `buildDeviceDigest` for parity with on-chain verifier |
| `src/vpp-cloud.ts` | 116 | `DeviceRegistry`, `VppCloud.cosign(packet)` (verifies device sig, co-signs binding `(deviceDigest, deviceSignature, vppAddress)`), `cosignBatch` with accepted/rejected partition |
| `src/oracle-router.abi.ts` | 22 | Minimal ABI: tuple + flat `submitMeasurement` overloads, `registerDevice`, `deviceToVpp`, `MeasurementAccepted`/`MeasurementRejected` events |
| `src/submitter.ts` | 165 | ethers v6 wrapper, transient-error retry/backoff, DRY_RUN support, probes which `submitMeasurement` overload exists on the deployed contract |
| `src/index.ts` | 232 | commander CLI: `simulate-vpp`, `single-packet`, `register-device` |
| `scripts/demo-vpp-fleet.ts` | 169 | 3-region demo (Texas-solar 8 devices, Berlin-wind 10 devices, Sydney-solar 5 devices), 24h sim time, 2 pkt/hr/device, attacker on `vpp-tx:device-000` |

Total: ~1,560 lines of new code/config (excluding README + this log).

---

## Design decisions and deviations from blueprint

### 1. Signature scheme: EIP-191 prefixed by default
**Blueprint:** "device_signature (ECDSA secp256k1)" — does not pin the prefix.
**Decision:** Use EIP-191 (`\x19Ethereum Signed Message:\n32` + keccak) because that is what `ethers.Wallet.signMessage` produces and what OpenZeppelin's `MessageHashUtils.toEthSignedMessageHash` builds. Easiest path for the smart-contracts agent: `ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(digest), sig)` against the registered signer address.
**Escape hatch:** `DEVICE_DIGEST_RAW` is exported for raw-digest recovery if the contract author prefers no prefix. Single-line flip in `vpp-cloud.ts`.

### 2. ABI encoding: `abi.encode`, not `encodePacked`
**Why:** explicit width per field eliminates the `uint8` adjacent-collision footgun that plagues `encodePacked`. Slight gas cost (a few hundred gas per call on submit) for guaranteed correctness. Field order/widths declared once in `PACKET_ABI_TYPES` and must mirror `OracleRouter.sol`.

### 3. Dual signature binds device portion + VPP address
**Choice:** VPP cloud signs `keccak256(abi.encode(deviceDigest, deviceSignature, vppAddress))` rather than just `deviceDigest`. Why: prevents a malicious VPP from forwarding a different VPP's packet under its own identity (signature swap). Mild cost for a real anti-replay benefit.

### 4. Deterministic identities from string labels
Device + VPP keys are derived via `keccak256("exergy-sim:" + label)` so the same fleet exists on every run. Lets the smart-contracts agent pre-register devices once (via `register-device` CLI) and reuse them across sessions. Production reality is the opposite — keys are HSM-bound and never leave the chip — but for testnet stability this trade is right.

### 5. Realistic telemetry, not random noise
- **Solar:** half-cosine bell over local daylight hours; daylight derived from latitude + day-of-year via Cooper's declination approximation; cloud cover modeled as a slow random walk multiplier.
- **Wind:** AR(1) `w_t = 0.85 * w_{t-1} + 0.15 * noise`, bounded to [0,1]. Autocorrelated like real wind output.
- **Hydro:** near-constant ~70%, small drift. Dispatchable.
- **Demand profile:** Gaussian-ish bumps at 8:00 and 20:00 local (residential morning + evening peaks). Drives discharge so cycles actually accumulate.
- **Cycle counter:** floor-divides accumulated discharge throughput by capacity. Partial cycles do NOT increment.

This matters for investor demos — a graph of 24h kWh per VPP should look like a real solar farm, not Brownian motion.

### 6. Anomaly hooks for testing rejection paths
`attackerMode` flag injects a device that reports `10 * actual + capacity*(cycles+1)` kWh. Anomalies are logged but the packet is still emitted + signed so the contract-level rejection path can be exercised against real network calls. The demo wires `vpp-tx:device-000` as the attacker by default.

### 7. Submitter probes contract overload at runtime
The blueprint does not pin the exact `submitMeasurement` Solidity signature. Two shapes (tuple-of-fields, or flat-args) are both encoded in the ABI; `submitter.ts::probeShape` picks the one present. Reduces coordination cost with the smart-contracts agent.

### 8. Strict TS config
`strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters` all on. No `any` in any module. All public APIs typed; bigints used wherever the on-chain type is uint256/uint64/uint32.

### 9. No npm install run
Per spec — files only. Compilation/lint/test happens when Mag (or the next agent) installs deps.

---

## How to run end-to-end

### Offline (no on-chain submit; signatures still produced)
```bash
cd Exergy/MVP/oracle-simulator
npm install
npx ts-node scripts/demo-vpp-fleet.ts
```
You will see structured logs from `battery-sim`, `edge-device`, `vpp-cloud` for each tick. No tx hashes (offline mode).

### On-chain (Arbitrum Sepolia)
```bash
cp .env.example .env
# Fill: ARBITRUM_SEPOLIA_RPC_URL, ORACLE_ROUTER_ADDRESS, SUBMITTER_PRIVATE_KEY
# Pre-register devices (owner-only):
for vpp in vpp-tx vpp-be vpp-au; do
  for i in $(seq -w 0 4); do
    npx ts-node src/index.ts register-device --vpp $vpp --device "$vpp:device-$i"
  done
done
# Run the 24h fleet demo:
npx ts-node scripts/demo-vpp-fleet.ts
# tail output for component=submitter to see tx hashes.
```

### Single-packet smoke test
```bash
npx ts-node src/index.ts single-packet --device vpp-tx:device-000 --vpp vpp-tx --kwh 2.5
```

---

## Open questions for the smart-contracts agent

1. **Signature scheme:** EIP-191 prefixed digest (what we ship), or raw-digest recovery? Either is one-line for us to flip — pick whichever is cleaner inside `OracleRouter.verifySignatures`.
2. **submitMeasurement shape:** tuple-of-fields (recommended) vs flat 9 args. We support both via runtime probe; just pick one.
3. **`registerDevice` permissioning:** the simulator assumes the OracleRouter owner registers. If the design uses per-VPP delegated registration (VPP registers its own devices), expose `registerDevice` on the VPP role and update the README example.
4. **Proof-of-Wear enforcement location:** should anomalous-cycles checks live in `OracleRouter` (rejected at oracle layer) or `MintingEngine` (mint rejected, packet still recorded)? Affects which rejection event the dashboard listens to.
5. **`vppDigest` field exposed?** Right now we include `vppDigest` in `DualSignedPacket` for our own logging, but it is NOT submitted on-chain (the contract recomputes from device signature + vppAddress). Confirm the contract recomputes; if it expects us to pass it explicitly, add to `submitMeasurement` signature.
6. **Pubkey hash vs address in registry:** blueprint says "public key hash" but `verifyMessage` recovers an address. We currently expose both (`registerDevice(deviceId, vpp, pubKeyHash)` and `expectedSigner` keyed on address) — confirm which the contract actually stores.
7. **Chainlink External Adapter:** the simulator submits directly to OracleRouter, skipping the Chainlink 3-of-5 consensus described in the blueprint. For Phase 0 this is fine (single-party submit); for Phase 1 we need to add a Chainlink adapter shim. Not blocking now.

---

## Status

- [x] All 10 files specified in the brief written
- [x] TypeScript strict mode, no `any`
- [x] Realistic energy profiles (not noise)
- [x] Cycle accounting (no increment on every measurement)
- [x] Anti-cheating anomaly hooks
- [x] Retry logic + DRY_RUN + structured logging
- [ ] `npm install` — deferred per spec
- [ ] `npm run lint:types` — deferred (needs install)
- [ ] End-to-end run against deployed OracleRouter — blocked on smart-contracts agent shipping the testnet contract
