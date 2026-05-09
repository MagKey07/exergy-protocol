# Exergy MVP — Concept-Fidelity Audit

**Auditor:** Turpal (HQ)
**Date:** 2026-05-09
**Scope:** Phase 0 deliverables — `contracts/`, `oracle-simulator/`, `dashboard/`, `test/`
**Reference doctrine:** `Exergy/05_System/CORE_THESIS.md`, `Exergy/01_Pitch/Technical_Blueprint.md`, `HQ/memory/exergy_master.md`

> **Reading guide:** I read CORE_THESIS, exergy_master, and Technical_Blueprint cover-to-cover before opening any code, then audited each .sol file, the oracle simulator TS, and the dashboard wiring. This is a concept audit, not a security audit. No code modified.

---

## Section 1 — Concept invariants checklist

| # | Invariant | Status | Evidence |
|---|---|---|---|
| 1 | Energy Asymmetry as perpetual heartbeat (P2P + cross-VPP) | Aligned | `Settlement.sol::settleEnergy` (intra-VPP) + `Settlement.sol::crossVPPSettle` (cross-VPP). Both are pure transfers — money flows where energy is. |
| 2 | NO BURN | Aligned | `grep burn` returns only the explicit "NO BURN" comments in `Settlement.sol:21,125,139`, `MintingEngine.sol:46,227`, `XRGYToken.sol:20`. ERC20Burnable is NOT inherited. `recordEnergyConsumption` decrements `totalVerifiedEnergyInStorage` only — supply never moves down. |
| 3 | Halving by token count, not kWh | Aligned | `MintingEngine.sol:362-374` `_checkAndAdvanceHalving` reads `totalTokensMinted` (in 18-decimal wei) and compares against `halvingThreshold * (era + 1)`. `halvingThreshold = 1_000_000 * 1e18` set at init (line 139). The kWh column in the schedule is a derived consequence, not a trigger. |
| 4 | Floating index = totalVerifiedEnergyInStorage / totalSupply, 18-decimal | Aligned | `MintingEngine.sol:324-328` `getFloatingIndex()` returns `(totalVerifiedEnergyInStorage * 1e18) / token.totalSupply()`. Defensive `0` when supply is zero. Continuous (recomputed every read), no rebase, no oracle peg. |
| 5 | Anti-Simulation Lock — single signature MUST revert | Aligned (logic) / Drift (encoding interop) | `OracleRouter.sol:163-178` — both `InvalidDeviceSignature` and `InvalidVPPSignature` are independently checked and revert. ✅. BUT the VPP-digest encoding is inconsistent across components — see Drift D-1. |
| 6 | Proof-of-Wear (cumulativeCycles tracked + anomaly-flagged) | Drift | `cumulativeCycles` is in `IOracleRouter.MeasurementPacket` (line 34) and is fed into the digest, but `OracleRouter.sol` and `MintingEngine.sol` never read it after recovering the signature. No anomaly check, no rejection path. The simulator's own comment (`battery-sim.ts:20`) calls out "for testing the contract's rejection path" — but that path does not exist. Sybil resistance is signed-into-the-payload-only, not enforced. |
| 7 | Tokens NEVER sold | Aligned | `XRGYToken.sol::mint` is gated to `mintingEngine` only (`if (msg.sender != mintingEngine) revert NotMintingEngine();`). No `mintToTreasury`, no `mintForSale`, no public mint, no sale-style fallback. Constructor mints zero. The only path to supply is `MintingEngine.commitVerifiedEnergy` which itself is gated to OracleRouter only. |
| 8 | Equity model preserved (no token allocation) | Aligned | `Genesis supply: 0` enforced by absence of any constructor-mint. No vesting contract, no investor allocation, no airdrop, no premine path. Treasury accrues only via the `40%` fee share inside `Settlement._distributeFees` — paid in $XRGY that already exists, not freshly minted. |
| 9 | Sectoral currency (no peg, no rebase) | Aligned | No `setPrice`, no `chainlinkPriceFeed`, no rebase function. `getFloatingIndex` is a measurement, not a peg. |
| 10 | 24-hour epochs enforced | Aligned | `MintingEngine.sol:78,331-334`. `EPOCH_DURATION = 1 days`, `currentEpoch = (now - genesis) / EPOCH_DURATION`. Replay protection by packet hash (`OracleRouter._processed`) — same packet cannot mint twice in any epoch. Sealed-epoch guard (`MintingEngine.sol:196`) blocks late writes after seal. |
| 11 | NO MANUAL INTERVENTION | Drift (BLOCKER for mainnet) | Heavy admin surface across all 4 upgradeable contracts. See Drift D-2 (UUPS upgradability), D-3 (Pause everywhere), D-4 (Settlement fee setters), D-5 (TEST_HOOK_ROLE), D-6 (no timelock). All TESTNET-OK if and only if every admin role is renounced/transferred to a timelock+governance before mainnet. CORE_THESIS §5.5 is unambiguous: "All rules, thresholds, sanctions, and recovery mechanisms are encoded in smart contracts. No human reviews." |
| 12 | Open-source readiness | Drift | All 10 `.sol` files have SPDX-License-Identifier: MIT ✅. README mentions open-source intent in passing but there is **no `LICENSE` file** at `MVP/` root. Public-readiness gap. No `CONTRIBUTING.md`, no protocol-spec doc for third-party VPP-cloud / Chainlink-adapter implementers. |
| 13 | Verification cheap (no own consensus) | Aligned | OracleRouter does ECDSA signature recovery only (cheap). MintingEngine does a halving check + arithmetic. No PoW, no PoS-style stake/slash. Trust comes from off-chain dual-signature pipeline + (future) Chainlink 3-of-5. Inherits Arbitrum/Ethereum PoS. |

**Score: 9 Aligned, 4 Drift, 0 outright Violations.**

---

## Section 2 — Drift catalog

### D-1 — Three inconsistent VPP-digest encodings (interop bug, not concept drift, but blocks the dual-sig demo)

- **Files:**
  - `contracts/OracleRouter.sol:175` — `keccak256(abi.encode(packetHash /*bytes32*/, deviceSignature /*bytes*/))`
  - `test/helpers/signatures.ts:57-60` — `keccak256(abi.encode(packetTuple, deviceSignature))` (encodes the **packet itself**, not its hash)
  - `oracle-simulator/src/vpp-cloud.ts:32-40` — `keccak256(abi.encode(deviceDigest, deviceSignature, vppAddress))` (extra `vppAddress` field)
- **What CORE_THESIS says:** "no centralized software gatekeeping" — multiple implementations must interop. SDK spec must be unambiguous so a Gmail/Outlook-style ecosystem of VPP-cloud signers can plug in.
- **Severity:** SERIOUS. Three different "canonical" encodings means (a) Settlement E2E test will fail against the deployed router, and (b) any third-party cloud-signer following the simulator will be rejected by the contract — exactly the centralization risk CORE_THESIS warns about.
- **Recommended fix:** Pick ONE canonical form (the contract's `abi.encode(packetHash, deviceSignature)` is the simplest and is what's already on-chain). Update `signatures.ts` and `vpp-cloud.ts` to mirror it. Publish the encoding in a `docs/PROTOCOL_SPEC.md` as the single source of truth.

### D-2 — Universal UUPS upgradability across MintingEngine / OracleRouter / Settlement / ProtocolGovernance

- **Files:** `MintingEngine.sol:380`, `OracleRouter.sol:220`, `Settlement.sol:274`, `ProtocolGovernance.sol:183`. Each declares `_authorizeUpgrade(...) onlyRole(UPGRADER_ROLE)`.
- **What the code does:** A single admin holding `UPGRADER_ROLE` can swap the implementation behind any of these proxies and rewrite any rule, including the halving threshold or the mint-gating check. There is no timelock and no on-chain review window.
- **What CORE_THESIS says:** Rules encoded in smart contracts. No subjective decisions. The token contract itself is correctly NOT upgradeable (`XRGYToken.sol:25-26`: "INTENTIONALLY immutable") — that decision is on-thesis. Engine/Router/Settlement holding the same trust posture as the token would be on-thesis too.
- **Severity:** TESTNET-OK / mainnet BLOCKER. UUPS is fine while we are iterating the engine on testnet, but on mainnet the upgrade authority must be a TimelockController owned by a multi-stakeholder governance (or burned outright — Bitcoin-style).
- **Recommended fix:** Before mainnet, transfer `UPGRADER_ROLE` on all three modules to a 48-hour `TimelockController`, then revoke the deployer's role. Document this in a `MAINNET_HARDENING.md` checklist.

### D-3 — Pause function on every contract, role held by a single admin

- **Files:**
  - `MintingEngine.sol:265-271` — `pause()/unpause()` halts `commitVerifiedEnergy` and `recordEnergyConsumption`
  - `OracleRouter.sol:194-200` — `pause()/unpause()` halts `submitMeasurement`
  - `Settlement.sol:230-236` — `pause()/unpause()` halts settle flows
  - `ProtocolGovernance.sol:123-132` — `pauseProtocol()/unpauseProtocol()`
- **What the code does:** A single `PAUSER_ROLE` holder can stop minting, settlements, and oracle submissions globally. This is precisely the "human review / subjective decision" pattern CORE_THESIS rejects.
- **What CORE_THESIS / Technical_Blueprint says:** Blueprint §3 spells out auto-recovery: "3 consecutive failures → VPP auto-deactivated by contract. Reactivation: N consecutive clean epochs. No manual intervention." The current contracts implement none of this autonomic logic — they substitute manual `pause()` for it.
- **Severity:** TESTNET-OK / mainnet BLOCKER. For Phase 0 demos a pause is pragmatic; for mainnet it is a "the founder can freeze your money" gun pointed at every VPP partner.
- **Recommended fix:**
  - Mainnet: replace `PAUSER_ROLE` admins with the same timelock as `UPGRADER_ROLE`, and add the **autonomous** circuit-breaker described in Blueprint §3 (per-VPP auto-deactivation after N consecutive Chainlink/DSO disagreements, auto-reactivation after M clean epochs). That is the on-thesis equivalent of pause.
  - Sprint extension: implement the auto-deactivation/reactivation logic on `OracleRouter` so the per-VPP `setDeviceActive` is driven by the contract itself, not by `DEVICE_REGISTRAR_ROLE`.

### D-4 — Mutable fee bps and mutable fee recipients on Settlement

- **File:** `Settlement.sol:217-227` (`setSettlementFeeBps`, `setMintingFeeBps`) and `Settlement.sol:205-214` (`setFeeRecipients`).
- **What the code does:** `FEE_MANAGER_ROLE` can move the settlement fee bps anywhere in `[0, MAX_FEE_BPS=1000]` and re-route the four fee recipients (treasury / team / ecosystem / insurance) to any address.
- **What CORE_THESIS says:** Fees are economic parameters that flow into the equity story (treasury captures 40% of fees → equity appreciates). Mutating them post-launch is a soft form of "human reviews / subjective decisions" and re-pointing the recipient is a literal hostile-takeover vector.
- **Severity:** TESTNET-OK / mainnet SERIOUS. Distinct from D-3 because fees aren't a crash-stop — but a malicious or compromised admin can quietly drain the treasury stream.
- **Recommended fix:**
  - Make `MAX_FEE_BPS` and the four `*_SHARE_BPS` constants immutable (already are — good). Make `settlementFeeBps` / `mintingFeeBps` immutable too: bake `25` and `100` in as constants. If fee-tuning is desired, only allow it via the same timelocked governance route, never via a single role-holder.
  - Recipient changes should require a 48h timelock and emit a clearly visible event off-chain monitor catches.

### D-5 — TEST_HOOK_ROLE in MintingEngine lets admin forge any state

- **File:** `MintingEngine.sol:283-312` — four functions: `adminSetTotalVerifiedEnergy`, `adminSetEra`, `adminSetHalvingThreshold`, `adminSetGenesisTimestamp`.
- **What the code does:** Anyone with `TEST_HOOK_ROLE` (granted to `admin` at init) can rewrite the floating-index numerator (`totalVerifiedEnergyInStorage`), fast-forward the halving era, change the halving threshold, or move genesis. Combined this is "I can fabricate any monetary history I want."
- **What CORE_THESIS says:** Math measures the pool, not authority. The whole point.
- **Severity:** TESTNET-OK explicitly (the contract calls itself out: line 281 "MUST NOT exist in production deployment"). Mainnet **BLOCKER** if not stripped.
- **Recommended fix:**
  - Add a `MAINNET_HARDENING.md` step: "Revoke TEST_HOOK_ROLE from all addresses, then renounce DEFAULT_ADMIN's ability to grant it." Better: gate the four `adminSet*` functions behind `if (block.chainid == ARBITRUM_MAINNET) revert TestHookOnTestnet();` so even a buggy script can't accidentally grant the role on mainnet.
  - Sprint extension: write a mainnet-deploy script that asserts these roles are zero before declaring success.

### D-6 — ProtocolGovernance has no 48h timelock despite the spec calling for it

- **File:** `ProtocolGovernance.sol:28-29` — explicit comment: "No 48h timelock. Single GOVERNOR_ROLE acts immediately."
- **What CORE_THESIS / Blueprint §10.3 says:** "Protocol-level parameters are governed by on-chain mechanism with 48h timelock. Allows community to redirect the treasury fee stream to an alternative operator entity if Key Energy ever becomes a bad actor. Timelock prevents instantaneous malicious changes. This is a deliberate checks-and-balances design." This is part of the **investor pitch** about protocol continuity.
- **Severity:** TESTNET-OK / mainnet SERIOUS. Investor narrative cannot survive a question like "where is the timelock?" if the answer is "we said it would be there but we didn't build it."
- **Recommended fix:** In sprint extension, add an `OZ TimelockController` deployment and reroute `GOVERNOR_ROLE` / `UPGRADER_ROLE` / `FEE_MANAGER_ROLE` / `PAUSER_ROLE` through it. Doc the latency in `06_INVESTOR_DEMO_SCRIPT.md`.

### D-7 — Cumulative-cycles signed but never validated

- **Files:** `IOracleRouter.MeasurementPacket.cumulativeCycles` (line 34); recovered into the device digest (`OracleRouter.sol:160-167`); never read after that. `oracle-simulator/src/battery-sim.ts:20` claims it generates anomalous values "for testing the contract's rejection path."
- **What CORE_THESIS / Blueprint §5.6 says:** Proof-of-Wear is the native Sybil resistance. "Anomalous cycling patterns relative to storage capacity and grid demand data are flagged by the oracle layer and rejected by the minting contract at the epoch boundary."
- **Severity:** SERIOUS for the concept story (this is the *first* differentiator vs PoW/PoS the deck advertises — and right now it is decoration, not enforcement). TESTNET-OK as a pragmatic Phase-0 corner cut, but it must not be advertised as live until the check is wired.
- **Recommended fix:** Add to `MintingEngine.commitVerifiedEnergy` a per-device `lastCycles[deviceId]` mapping. Reject packets where `(packet.cumulativeCycles - lastCycles[deviceId]) * kWhPerCycleEstimate > storageCapacity * MAX_CYCLES_PER_EPOCH`. Threshold in spec: NREL says ~1 full cycle/day ⇒ flag if >2 cycles in a 24h epoch for the same battery. This is a 30-line addition, all autonomous, fully on-thesis.

### D-8 — Settlement test uses an obsolete signature; integration is silently broken

- **File:** `test/Settlement.t.ts:1-19` (header explicitly says "Interface for Settlement is not yet committed by the contracts agent — this test file is written against the spec verbatim"). Multiple call sites (lines 75, 92, 109, 118, 187) call `settleEnergy(provider, recipient, amount)` — but the deployed contract is `settleEnergy(address provider, uint256 tokenAmount, uint256 kwhConsumed)`.
- **What CORE_THESIS says:** Not directly applicable — but a sprint extension that ships an audit-ready package needs green tests against the actual ABI.
- **Severity:** SERIOUS (build hygiene, blocks the "we tested the protocol" claim).
- **Recommended fix:** Rewrite `Settlement.t.ts` against the actual `Settlement.sol` ABI. Same for any other tests that drifted away.

### D-9 — Dashboard calls `settleCrossVPP` — no such function exists

- **Files:** `dashboard/src/pages/Settlement.tsx:186` (`functionName: "settleCrossVPP"`) and `dashboard/src/lib/contracts.ts:293` (ABI declares `settleCrossVPP`). Real contract function: `Settlement.sol:157` `crossVPPSettle(address receiver, bytes32 counterpartyVPPId, uint256 tokenAmount)`. Argument order in dashboard (`toVpp, to, amountWei, memoHash`) is also wrong — actual contract takes 3 args, not 4, and there is no `memoHash` parameter.
- **Severity:** SERIOUS (the cross-VPP demo path is broken end-to-end). On-thesis, this is the single most important UI story — energy-asymmetry market emergence.
- **Recommended fix:** Sync the dashboard ABI to the deployed Settlement contract. Drop `memoHash` (or extend Settlement to accept it as `bytes32 memoRef` if the storytelling needs it). Rename function call site to `crossVPPSettle`.

### D-10 — `Anti-Simulation Lock` works but readme says VPP cloud signature is a gating attestation; we don't enforce VPP-cloud-key revocation propagation

- **Files:** `OracleRouter.sol:151` reads `_devices[deviceId].vppAddress` per packet, but VPP keys can only be rotated by re-`registerDevice` (which itself reverts if device exists). There is no `setDeviceVPP` function and no `setVPPKey` rotation path.
- **Severity:** MINOR for now. If a VPP cloud key is compromised on testnet you cannot rotate without re-deploying / re-registering. Concept doesn't require rotation in Phase 0; it does require it for production.
- **Recommended fix:** In sprint extension, add an autonomous rotation flow: VPP signs a "rotate to newKey" message with their old key, OracleRouter accepts and rebinds. No admin in the loop, fully on-thesis.

---

## Section 3 — Concept gaps NOT yet implemented

1. **No `LICENSE` file at MVP/ root.** SPDX headers exist on every `.sol` but a top-level `LICENSE` (MIT text) is missing. Required before the repo goes public on GitHub.
2. **No public README at the protocol root** explaining "what Exergy is" in monetary-thesis terms; the current `README.md` is a Phase-0 dev note. Investor or developer cloning the repo would not see the thesis.
3. **No `PROTOCOL_SPEC.md` for the dual-signature dialect.** Anyone trying to write an alternative VPP-cloud signer (the SMTP-style ecosystem CORE_THESIS describes) has to reverse-engineer it from `OracleRouter.sol`. This is exactly the "centralized software gatekeeping" risk we're supposed to refuse.
4. **No Chainlink External Adapter integration.** The Blueprint §3 calls for 3-of-5 node consensus + DSO cross-check; the current router accepts the dual-signed packet and forwards directly to `MintingEngine`. Acceptable for Phase 0 (`OracleRouter.sol:36` "Phase 1 swaps it in transparently") — must be the next sprint's #1 deliverable.
5. **No Proof-of-Wear enforcement** (D-7).
6. **No autonomous VPP auto-deactivation / auto-reactivation** logic per Blueprint §3 ("3 consecutive failures → auto-deactivated… No manual intervention").
7. **No on-chain treasury accumulation reporter** to surface the 40% fee story to investors. Distribution exists; an aggregate counter does not.
8. **No `MAINNET_HARDENING.md`** that lists every role to renounce, every `adminSet*` to revoke, and the timelock wiring.
9. **No reference test that the contract+simulator+dashboard digest formats agree** (D-1 would have been caught by such a test).

---

## Section 4 — Concept-aligned guardrails for the next sprint extension

If the next sprint adds Chainlink External Adapter + testnet deploy + open SDK spec:

- **Chainlink Adapter must be deterministic.** No "approve this packet anyway" override, no admin allowlist for "trusted VPPs whose data we accept without DSO cross-check." If the 3-of-5 or DSO check fails, the contract refuses; the only recovery is the autonomic re-activation rule.
- **SDK spec publishes the canonical dual-signature scheme.** One `PROTOCOL_SPEC.md` file with the exact `abi.encode` types, the EIP-191 prefix decision, and a reference TS implementation. Eliminates D-1 forever and lets a Gmail/Outlook ecosystem of VPP-cloud signers emerge — that's the on-thesis answer to "no centralized software gatekeeping."
- **No new admin functions.** Every new feature added in the sprint extension must land as either pure logic or autonomous-rule logic. Anything that takes `onlyRole(...)` adds to the mainnet-strip list.
- **All new constants are `constant` not storage.** If something is a parameter (kWh/cycle wear floor, max cycles/epoch, anomaly threshold), declare it `constant` in the engine. If it must be tunable, gate it behind the same timelock that governs upgrades — not behind a `setX` function with an admin role.
- **Add a MAINNET_HARDENING.md and CI gate.** A script that asserts on the deployed mainnet bytecode: no `TEST_HOOK_ROLE` members, no admin holders of `UPGRADER_ROLE` (timelock only), no admin holders of `PAUSER_ROLE` (or remove pause entirely if the autonomic circuit breaker is in place).
- **Cycle-rate enforcement (D-7) shipped with the adapter sprint.** The Chainlink adapter is the natural place to surface anomaly events; the engine should reject on-chain.
- **Open-source the repo at sprint end.** LICENSE, public README, PROTOCOL_SPEC, CONTRIBUTING, security-disclosure email. The cheapest credibility multiplier we have — and CORE_THESIS already commits us to it ("open-source from day one").
- **Demo script that visibly demonstrates Energy Asymmetry.** Two simulated VPPs, one cycling positive (mints), one short (must buy on a mock DEX to settle a neighbour). The whole point of the protocol is two physical asymmetries meeting on one exchange — the demo must show that, not a single-VPP minting loop.

---

## Section 5 — Honest verdict for Mag

The Phase 0 implementation is **mostly faithful to the monetary thesis** — the load-bearing primitives (no burn, no token sale, halving by count, floating-index measurement, dual-signature anti-simulation, 24h epochs, no peg, no rebase) are all present and correctly wired. Out of 13 invariants, 9 are aligned and the 4 drift cases are concentrated in one cluster: an admin-control surface (UUPS upgrade, pause, mutable fees, TEST_HOOK_ROLE, no timelock) that is acceptable for testnet iteration but is a hard mainnet blocker because CORE_THESIS §5.5 explicitly rules out "human reviews, no subjective decisions." Beyond the admin cluster, the most consequential single drift is **Proof-of-Wear is decoration, not enforcement** (D-7): cumulativeCycles is signed into every packet but no contract reads it. That is the protocol's signature differentiator vs PoW/PoS in the deck — it must become real before we tell investors the system is live. There are also three integration mismatches (D-1, D-8, D-9) — the contract, the test helpers, the simulator, and the dashboard all encode/call slightly different versions of the same operation, which is the second-most worrying sign because it is exactly the "centralized software gatekeeping" failure mode CORE_THESIS warns about. Recommendation: **proceed with the sprint extension AND fix drift in parallel.** D-1 / D-7 / D-8 / D-9 are surgical (under 200 LOC total) and they are prerequisites for any honest investor demo. The admin-control hardening (D-2 through D-6) can wait for the pre-mainnet cycle but the `MAINNET_HARDENING.md` checklist should be written in this sprint so we don't forget. Phase 0 is solid bones; the next sprint is about making the bones load-bearing without growing a head of admin overrides.
