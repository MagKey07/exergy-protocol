# 08 — Chainlink External Adapter build log

**Sprint:** Phase 0 extension (Day 2)
**Author:** Turpal (HQ)
**Date:** 2026-05-09
**Goal:** Insert the Chainlink External Adapter layer between the VPP
Cloud and `OracleRouter`, replacing the Phase 0 shortcut where the
oracle simulator submitted dual-signed packets directly to the contract.

This addresses **CONCEPT_AUDIT Section 3 item 4** — "No Chainlink External
Adapter integration" — which was flagged as the next sprint's #1 deliverable.

---

## Files created

### `MVP/chainlink-adapter/` (new package)

| File                              | Lines | Purpose |
|-----------------------------------|------:|---------|
| `package.json`                    |    34 | Node.js deps: ethers, express, winston, commander, ts-node, typescript |
| `tsconfig.json`                   |    30 | Strict TS, mirrors oracle-simulator |
| `.env.example`                    |    36 | RPC, relayer key, OracleRouter address, port, DSO noise range |
| `.gitignore`                      |     6 | node_modules / dist / .env / logs |
| `src/types.ts`                    |   126 | `MeasurementPacket`, `SubmitRequest`, `ConsensusResult`, `AdapterConfig`, **immutable consensus + DSO constants** |
| `src/logger.ts`                   |    44 | Winston pretty/json — mirror of simulator logger |
| `src/oracle-router.abi.ts`        |    21 | Tuple-form `submitMeasurement` + role-check views |
| `src/verifier.ts`                 |   106 | Off-chain ECDSA recovery (defence-in-depth, byte-parity with `OracleRouter.sol`) |
| `src/dso-mock.ts`                 |    63 | Mock DSO cross-reference, ±5% per-node noise, 20% threshold |
| `src/consensus.ts`                |    63 | 3-of-5 simulated Chainlink node consensus, no admin override |
| `src/relayer.ts`                  |   163 | Submits accepted packet on-chain via `CHAINLINK_RELAYER_ROLE` wallet, retry + backoff |
| `src/server.ts`                   |   180 | Express HTTP server: `/submit`, `/health`, `/version` |
| `src/index.ts`                    |   118 | Commander CLI: `start`, `health`, `tx-status <hash>` |
| `README.md`                       |   170 | Architecture, install/run, HTTP API, "write your own adapter" guidance |
| `test/verifier.test.ts`           |   122 | Sig recovery + dialect parity, regression guard for CONCEPT_AUDIT D-1 |
| `test/dso-mock.test.ts`           |    74 | Honest packets always pass, >20% always fails, deterministic RNG |
| `test/consensus.test.ts`          |    96 | 3-of-5 boundary, no override path, constant-checks |

### Modified files

| File                                                          | Change                                                              |
|---------------------------------------------------------------|---------------------------------------------------------------------|
| `MVP/contracts/OracleRouter.sol`                              | Added `CHAINLINK_RELAYER_ROLE`, gated `submitMeasurement`, added `setRelayer`, bootstrap relayer = admin in `initialize` |
| `MVP/contracts/interfaces/IOracleRouter.sol`                  | Mirror role event/error + `setRelayer` declaration                  |
| `MVP/scripts/deploy.ts`                                       | Doc: bootstrap CHAINLINK_RELAYER_ROLE → governor + production migration steps |
| `MVP/oracle-simulator/package.json`                           | Add `undici` HTTP client dep                                        |
| `MVP/oracle-simulator/.env.example`                           | Add `CHAINLINK_ADAPTER_URL`, `SUBMIT_MODE_DIRECT`                   |
| `MVP/oracle-simulator/src/submitter.ts`                       | New `AdapterSubmitter` class (POST /submit), legacy `Submitter` kept |
| `MVP/oracle-simulator/src/index.ts`                           | Default mode = adapter (V1), fallback to direct (V0) when adapter URL absent |
| `MVP/oracle-simulator/scripts/demo-vpp-fleet.ts`              | Default to adapter mode for end-to-end demo                         |
| `MVP/docs/PROTOCOL_SPEC.md`                                   | Appended `## V1 — Chainlink Layer (additive)` with HTTP API contract, consensus rules, open-ecosystem requirements |

---

## Architecture decisions (with rationale)

### D1. Adapter is **additive security**, not a replacement

The contract still verifies dual signatures on every `submitMeasurement` call,
and the on-chain registry binding (device → VPP) is the source of truth.
The adapter's verifier is a fail-fast mirror — if signatures are malformed
the adapter rejects 422 instead of burning gas on a guaranteed revert.

**Rationale:** CORE_THESIS "no centralized software gatekeeping" — the
adapter is operationally critical but cryptographically replaceable. A
compromised adapter relayer key cannot mint anything that wasn't already
validly dual-signed by a registered device + VPP. The worst-case is a
liveness DOS, recoverable by granting the role to a different adapter
through governance.

### D2. `CHAINLINK_RELAYER_ROLE` as a **single-address binding**, not a permissioned function

The role gate adds a single trust boundary: only the deployed adapter
address (or a small set of them) can call `submitMeasurement`. There is
NO new mutable function on the contract for "approve this packet anyway"
or "skip DSO for trusted VPPs" — any such surface would re-introduce the
admin-control cluster CONCEPT_AUDIT D-2 through D-6 already flagged as
mainnet blockers.

`setRelayer` is admin-callable to support migrations (testnet bootstrap →
production adapter, or rotating to a different adapter implementation),
but it grants the role; it does not bypass any other check. On mainnet it
must be timelocked per `MAINNET_HARDENING.md`.

### D3. Bootstrap relayer = admin (testnet only)

`OracleRouter.initialize` grants `CHAINLINK_RELAYER_ROLE` to the admin
address. This keeps existing deploy scripts, `seed-test-data.ts`, and the
V0 simulator path working on localhost / Sepolia without forcing the
adapter to be live before any test can run. Production deploys MUST:

1. Deploy the adapter and obtain its on-chain submitter address.
2. Call `oracleRouter.setRelayer(<adapter>)`.
3. `oracleRouter.revokeRole(CHAINLINK_RELAYER_ROLE, governor)` — remove
   the bootstrap binding so only the adapter can relay.

This is in `MAINNET_HARDENING.md` and in `scripts/deploy.ts` comments.

### D4. Constants for consensus and DSO threshold

3-of-5 and 20% are hard-coded `as const` exports in `src/types.ts`.
They are not exposed via env var, CLI flag, or HTTP control plane.

**Rationale:** A configurable threshold is a one-line code change away
from "the founder can quietly raise the threshold to allow malicious
packets through." Hard-coded constants make the policy auditable from
git history alone; changes require a code review + redeploy, not a hot
config flip. Aligned with CORE_THESIS §5.5 ("rules encoded in smart
contracts. No human reviews, no investigations, no subjective decisions.").

### D5. Stateless adapter

The adapter does NOT maintain a device registry. It computes the
recovered device address and pubKeyHash but does not check them against
any allowlist — that is the contract's job. The adapter is therefore
horizontally scalable and replaceable without state migration. Multiple
adapters can run in parallel (e.g. one per VPP region) and the contract
treats them all identically.

### D6. JSON wire format with bigint-as-decimal-strings

`uint256` fields (`kwhAmount`, `storageCapacity`, `timestamp`) are sent
as decimal strings. JSON has no native bigint and silently truncating
large values to JS number is the most common cause of off-by-wei
production bugs. The adapter parses with `BigInt(...)` which throws on
non-decimal input, surfacing client bugs immediately.

### D7. HTTP transport, not direct WebSocket / gRPC

Express + JSON keeps the surface area minimal and lets a real Chainlink
External Adapter (which is HTTP-based by Chainlink convention) drop in
as a swap, not a rewrite. `chainlink-adapter` is itself an emulation of
the Chainlink Adapter contract — when the protocol moves to mainnet, the
HTTP endpoint stays the same but the body of `consensus.ts` and
`dso-mock.ts` is replaced by a call to actual Chainlink jobs.

### D8. V0 (direct submission) kept as a regression / bootstrap path

`SUBMIT_MODE_DIRECT=1` flips the simulator back to the legacy direct
mode. Used for:

- Smoke-testing the contract path independently of the adapter.
- Running the demo when the adapter isn't started yet (developer iteration).
- Regression — if the adapter starts producing different bytes from V0,
  we want to catch that before deploy.

---

## Test coverage

`npm test` (using `node:test` runner — no jest/vitest dep):

- `verifier.test.ts` (6 cases): valid recovery, malformed sigs, dialect
  parity with the contract's `keccak256(abi.encode(packet))`, VPP digest
  binds only `(packetHash, deviceSig)` (regression guard for CONCEPT_AUDIT D-1).
- `dso-mock.test.ts` (5 cases): 1000 honest trials never reject, >20%
  inflation always rejects, exactly 20% boundary, zero-kwh edge, RNG
  determinism.
- `consensus.test.ts` (5 cases): 3-of-5 + 5-node constants, 200 honest
  trials all accept, all-malicious all reject, 3-accepts-boundary
  accepts, 2-accepts-boundary rejects.

E2E HTTP tests (curl-driven) deferred to Phase 0+1 demo prep — running
them requires a live Hardhat node and deployed contracts, and a
half-mocked HTTP test isn't worth the maintenance cost vs the manual
demo run.

---

## Open questions for next sprint

1. **Real Chainlink Aggregator integration.** When does Chainlink
   Functions or Chainlink Automation become more cost-effective than
   our custom adapter? The mock adapter is fine for testnet but a real
   DON has to be priced in for the Phase 1 budget (Technical_Blueprint
   §6 allocates $30K to "Infrastructure (cloud, oracle, gas)" — needs
   refinement once we have actual gas + oracle sub costs from a live
   testnet run).

2. **DSO API choice.** ENTSO-E for EU? NREL for US? Each VPP partner
   may need a different DSO source — does the protocol care, or do we
   leave it to per-region adapters? Probably the latter (concept-aligned
   open ecosystem), but the V1.4 spec entry should be clarified once we
   have Leigh's preferred data source.

3. **Multi-adapter governance.** The role can be held by N addresses
   simultaneously. Do we want quorum-of-adapters (e.g. 2 of 3 must agree
   before mint) or single-adapter-with-failover? Phase 0 is
   single-adapter; Phase 1 should answer this once we have a second
   adapter implementation.

4. **Testnet deploy.** Once we have a Sepolia deploy with the new role
   gate, we need to (a) re-run the seed script, (b) start the adapter
   pointed at it, (c) run `demo-vpp-fleet.ts` end-to-end, (d) verify
   `Mint` events flow through the dashboard. This is the headline demo
   for Leigh / investor pitches.

5. **Cycle-rate enforcement (CONCEPT_AUDIT D-7).** The natural place
   for this is in the adapter (not the contract) — anomalous cycling
   detection is exactly the kind of statistical check the adapter is
   built for. Adding `cumulativeCycles` history per device in the
   adapter would let it reject impossible cycle counts before relay,
   complementing the on-chain check the audit recommended for the
   engine. Phase 0+1 candidate.

6. **Adapter persistence.** Currently the adapter is fully stateless
   (correct per D5). If we add cycle-rate history (Q5), we need either
   on-chain state (clean, expensive) or off-chain Redis/Postgres (cheap,
   re-introduces a centralization point). Worth a concept review before
   implementing.

---

## How to run end-to-end

### 0. Prerequisites
- `node >= 20`, `npm`, `hardhat` (already installed in MVP/).
- `.env` files filled in `MVP/`, `MVP/oracle-simulator/`, `MVP/chainlink-adapter/`.

### 1. Start a Hardhat node
```bash
cd MVP
npx hardhat node                       # → http://127.0.0.1:8545
```

### 2. Deploy contracts + register devices
```bash
# Same terminal, new shell
npx hardhat run --network localhost scripts/deploy.ts
# Records addresses to MVP/deployments/localhost.json. The deployer EOA
# now holds CHAINLINK_RELAYER_ROLE on OracleRouter (bootstrap).

npx hardhat run --network localhost scripts/seed-test-data.ts
# Registers 3 mock VPPs (Texas, Berlin, Sydney) + their device fleets.
```

### 3. Start the Chainlink Adapter
```bash
cd MVP/chainlink-adapter
cp .env.example .env
# Edit .env:
#   ARBITRUM_RPC_URL=http://127.0.0.1:8545
#   ORACLE_ROUTER_ADDRESS=<from MVP/deployments/localhost.json>
#   RELAYER_PRIVATE_KEY=<deployer key from MVP/.env, since it's the bootstrap relayer>
npm install      # first time only
npm run dev      # → "adapter listening" on http://localhost:9000
# Optional sanity check:
npm run dev -- health
```

### 4. Run the simulator (default mode = adapter)
```bash
cd MVP/oracle-simulator
cp .env.example .env  # if not already
# In .env:
#   CHAINLINK_ADAPTER_URL=http://localhost:9000
#   ORACLE_ROUTER_ADDRESS=<same as adapter>
#   ARBITRUM_SEPOLIA_RPC_URL=http://127.0.0.1:8545
npm install      # first time only
npm run demo:fleet
# Each cosigned packet POSTs to the adapter; the adapter verifies, runs
# 3-of-5 consensus, and relays on chain. Watch:
#   - simulator log: "adapter-accepted" lines
#   - adapter log:   "tx-confirmed" lines
#   - dashboard:     mint events appearing on the live feed
```

### 5. Regression — direct mode

```bash
# In MVP/oracle-simulator/.env:
#   SUBMIT_MODE_DIRECT=1
npm run demo:fleet
# Submits straight to OracleRouter. Confirms the contract path still
# works after the role change. Useful as a CI smoke test.
```

---

## Concept-audit revisit

| CONCEPT_AUDIT item | Status after this sprint |
|---|---|
| §3 item 4 — "No Chainlink External Adapter integration" | **Closed.** Reference adapter shipped, simulator routes through it, contract role-gated. |
| §3 item 9 — "No reference test that the contract+simulator+adapter digest formats agree" | **Partially closed.** `verifier.test.ts` reproduces the canonical V0 dialect byte-for-byte; an end-to-end interop probe (contract <-> adapter <-> simulator on the same packet) is still pending and will land alongside testnet redeploy. |
| §4 — "Chainlink Adapter must be deterministic. No 'approve this packet anyway' override, no admin allowlist" | **Closed.** No admin override anywhere; constants are `const`; pipeline is pure. |
| §4 — "SDK spec publishes the canonical dual-signature scheme" | **Reinforced.** PROTOCOL_SPEC.md now has both V0 (signature dialect) and V1 (transport pipeline) sections. |
| §4 — "No new admin functions" | **Held.** Only `setRelayer` was added; it is a single-address binding, not a mutable parameter, and is on the same MAINNET_HARDENING.md timelock list as `UPGRADER_ROLE`. |
| §4 — "All new constants are `constant`, not storage" | **Held.** `CONSENSUS_THRESHOLD`, `CONSENSUS_NODE_COUNT`, `DSO_DISCREPANCY_THRESHOLD_BPS` are `as const` exports. |

Mainnet-blocker drift (D-2 through D-6) is unchanged — the adapter sprint
intentionally did not touch UUPS / Pause / fee setters / TEST_HOOK_ROLE,
per CONCEPT_AUDIT §4 ("admin-control hardening can wait for the
pre-mainnet cycle but the MAINNET_HARDENING.md checklist should be
written in this sprint" — already done in Day 1).
