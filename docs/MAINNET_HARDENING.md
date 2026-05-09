# MAINNET_HARDENING.md — Pre-Deployment Checklist

**Owner:** Key Energy, Inc. — engineering + governance.
**Audience:** Whoever cuts the mainnet deployment transaction.
**Status:** Locked checklist. Every box must be ticked, dated, and counter-signed before any contract address in this repo receives real value on Arbitrum One.

---

## Why this exists

CORE_THESIS §5.5 is unambiguous: *"All rules, thresholds, sanctions, and recovery mechanisms are encoded in smart contracts. No human reviews, no investigations, no subjective decisions."* The Phase 0 testnet contracts contain admin escape hatches — UUPS upgrade authority, pause functions, mutable fee parameters, a `TEST_HOOK_ROLE` that can rewrite monetary state — because iteration on testnet is faster with them than without. None of those escape hatches may exist on mainnet. CONCEPT_AUDIT.md classified five of them as "TESTNET-OK / mainnet BLOCKER" (D-2 through D-6). This document is the audit trail that those blockers were resolved before, not after, real money flowed through the protocol.

The form is intentionally a checklist, not prose. A project manager must be able to walk down it line by line and tick boxes. Empty fields next to each item are filled in at deploy time with the on-chain hash, block number, or timestamp that proves the gate was closed.

---

## A. Smart-contract pre-deploy checklist

### A.1 Admin role removal — MintingEngine

- [ ] **Revoke `TEST_HOOK_ROLE` from every address.**
  - On-chain query: `MintingEngine.getRoleMemberCount(TEST_HOOK_ROLE)` MUST return `0`.
  - Verification tx hash: `__________________________________`
  - Block number: `_____________`
  - Date / signer: `_____________`
- [ ] **Strip or chain-id-gate the four `adminSet*` functions** (`adminSetTotalVerifiedEnergy`, `adminSetEra`, `adminSetHalvingThreshold`, `adminSetGenesisTimestamp`).
  - Preferred path: deploy a new `MintingEngine` implementation with these functions deleted; route the upgrade through Timelock.
  - Acceptable interim: gate every `adminSet*` with `if (block.chainid == ARBITRUM_ONE_CHAINID) revert TestHookOnTestnet();`. The deploy script asserts the gate.
  - Implementation hash deployed: `__________________________________`
- [ ] **Transfer `UPGRADER_ROLE` to the deployed `OZ TimelockController` (48h delay per Blueprint §10.3), then revoke from deployer.**
  - Timelock address: `__________________________________`
  - Grant tx hash: `__________________________________`
  - Revoke-from-deployer tx hash: `__________________________________`
  - Post-state: `MintingEngine.getRoleMemberCount(UPGRADER_ROLE)` MUST equal `1`, and the single member MUST equal the Timelock.
- [ ] **Transfer `PAUSER_ROLE` to the same Timelock — OR remove the pause path entirely** if the autonomous circuit-breaker (D-3 recommendation, per-VPP auto-deactivation after N consecutive Chainlink/DSO disagreements) has landed.
  - Decision: ☐ moved to Timelock   ☐ pause removed in favor of autonomous circuit-breaker
  - If moved: grant tx `__________`, revoke-from-deployer tx `__________`
  - If removed: implementation hash `__________`, autonomous-rule unit-test commit `__________`
- [ ] **Transfer `DEFAULT_ADMIN_ROLE` to Timelock and renounce from deployer.**
  - Renounce tx hash: `__________________________________`
  - Post-state: `MintingEngine.getRoleMemberCount(DEFAULT_ADMIN_ROLE)` MUST equal `1` (Timelock only).

### A.2 Admin role removal — OracleRouter

- [ ] **Transfer `UPGRADER_ROLE` to Timelock, revoke from deployer.**
  - Grant tx: `__________`. Revoke tx: `__________`.
- [ ] **Transfer or remove `PAUSER_ROLE` (same decision as A.1).**
  - Decision: ☐ Timelock   ☐ removed
  - Tx hashes / implementation hash: `__________`
- [ ] **Transfer `DEFAULT_ADMIN_ROLE` to Timelock and renounce from deployer.**
  - Renounce tx: `__________`
- [ ] **`DEVICE_REGISTRAR_ROLE` policy decision documented.** Either (a) keep with Timelock for the pilot phase, or (b) replace with autonomous registration via Chainlink-attested LOI flow. Document the choice in a signed ADR.
  - ADR path: `__________`
  - Decision: ☐ Timelock-gated registration   ☐ autonomous flow

### A.3 Admin role removal — Settlement

- [ ] **Transfer `UPGRADER_ROLE` to Timelock, revoke from deployer.**
  - Grant tx: `__________`. Revoke tx: `__________`.
- [ ] **Transfer or remove `PAUSER_ROLE`.**
  - Tx / impl hash: `__________`
- [ ] **Transfer `FEE_MANAGER_ROLE` to Timelock — OR (preferred) make `settlementFeeBps` and `mintingFeeBps` immutable constants by deploying a new implementation that bakes in `25` and `100`.**
  - Decision: ☐ Timelock-gated   ☐ baked in as immutable constants
  - If immutable: implementation hash `__________`, fee values frozen at `settlementFeeBps = ____ bps`, `mintingFeeBps = ____ bps`.
  - If Timelock: grant tx `__________`, revoke tx `__________`.
- [ ] **Fee-recipient mutability disposition.** `setFeeRecipients` either (a) Timelock-gated or (b) made immutable in a redeployed implementation.
  - Decision: ☐ Timelock   ☐ immutable
  - Recipient addresses (final): treasury `__________`, team `__________`, ecosystem `__________`, insurance `__________`.
- [ ] **Transfer `DEFAULT_ADMIN_ROLE` to Timelock and renounce from deployer.**

### A.4 Admin role removal — ProtocolGovernance

- [ ] **Add the missing 48h timelock per Blueprint §10.3.** A redeployed `ProtocolGovernance` MUST route `GOVERNOR_ROLE` actions through the same `OZ TimelockController` used by all other modules. The current implementation comment ("No 48h timelock. Single GOVERNOR_ROLE acts immediately.") MUST not be present in the mainnet bytecode.
  - Implementation hash: `__________________________________`
- [ ] **Transfer `UPGRADER_ROLE`, `GOVERNOR_ROLE`, and `DEFAULT_ADMIN_ROLE` to Timelock, revoke from deployer.**
  - Tx hashes: `__________`, `__________`, `__________`.

### A.5 Token contract verification (already correct — verify post-deploy)

- [ ] **`XRGYToken.owner()` returns `address(0)`** (renounced). Already enforced by the immutable design but MUST be verified post-deploy.
  - Verification call result: `__________`
- [ ] **No `mint` caller other than the bound `MintingEngine` proxy.**
  - Proxy address bound: `__________________________________`
  - On-chain check call result: `__________`
- [ ] **`MintingEngineAlreadySet` error confirms the one-shot setter cannot be re-fired.** Test transaction reverts as expected.
  - Probe tx hash (expected revert): `__________`

### A.6 Concept-fidelity sweep

- [ ] **Sweep all five contracts for any `onlyRole(...)` modifier added since CONCEPT_AUDIT.md (2026-05-09).** Every new admin-gated function requires an explicit ADR justifying its presence on mainnet.
  - Diff range: `__________` → `__________`
  - New roles introduced: list `__________`
  - ADR for each: list `__________`
- [ ] **No new constants moved into storage.** Every parameter that a third party would expect to be policy (kWh-per-cycle wear floor, max cycles per epoch, anomaly threshold) is declared `constant`, not a tunable storage slot.
  - Manual review sign-off: `_____________`

---

## B. Audit and verification gates

- [ ] **Tier-1 security audit completed.**
  - Firm (one of OpenZeppelin / Trail of Bits / equivalent): `__________`
  - Audit report URL (public): `__________________________________`
  - Report hash (sha256): `__________________________________`
  - All HIGH and CRITICAL findings remediated. Remediation commit hashes:
    - HIGH-1 `__________`, HIGH-2 `__________`, ...
    - CRITICAL-1 `__________`, CRITICAL-2 `__________`, ...
- [ ] **Halving math formally verified** (Certora or equivalent) for boundary-crossing correctness.
  - Spec file path: `__________`
  - Tool: `__________`
  - Verification report: `__________`
- [ ] **Bug bounty program live with initial pool.**
  - Platform: ☐ Immunefi   ☐ HackenProof   ☐ Other: `__________`
  - Initial pool size (recommended $25-50K): `$__________`
  - Program URL: `__________________________________`
- [ ] **Etherscan / Arbiscan source verified for all five mainnet contracts.**
  - XRGYToken: `__________________________________`
  - MintingEngine (proxy + impl): `__________` / `__________`
  - OracleRouter (proxy + impl): `__________` / `__________`
  - Settlement (proxy + impl): `__________` / `__________`
  - ProtocolGovernance (proxy + impl): `__________` / `__________`

---

## C. Operational gates

- [ ] **Multi-sig wallet (3-of-5 or higher) controls Timelock proposer and executor roles. Single-key control is forbidden.**
  - Multi-sig type: ☐ Safe (Gnosis)   ☐ Other: `__________`
  - Multi-sig address: `__________________________________`
  - Threshold: `____ of ____`
  - Signer addresses (one per line, with off-chain identity attestation):
    1. `__________` — `_____________`
    2. `__________` — `_____________`
    3. `__________` — `_____________`
    4. `__________` — `_____________`
    5. `__________` — `_____________`
  - Tx hash assigning multi-sig to Timelock proposer/executor: `__________`
- [ ] **Insurance fund seeded.**
  - Initial seeding amount (in $XRGY, from the 15% fee share): `__________`
  - Distribution rules encoded in autonomous logic (no human discretion). Implementation hash: `__________`
- [ ] **Off-chain monitor running with alerts on:**
  - Any `RoleGranted` / `RoleRevoked` event on any of the five contracts
  - Any large fee-recipient change attempt (Timelock proposal events)
  - Any pause invocation (if pause is retained)
  - Any `Upgraded` event on any UUPS proxy
  - Monitor service: `__________`
  - Alert sink (PagerDuty / Slack / SMS): `__________`
  - Runbook for each alert: path `__________`

---

## D. Documentation gates

- [ ] **`PROTOCOL_SPEC.md` frozen at version 1.0.** The canonical dual-signature encoding, EIP-191 prefix decision, and reference TS implementation are published and stable. Third-party VPP-cloud implementers can rely on it.
  - Spec hash (sha256): `__________________________________`
  - Reference TS implementation commit: `__________`
- [ ] **Audit report linked from public README.md.**
  - README commit hash with link: `__________`
- [ ] **Mainnet contract addresses published on `keyenergy.io`.**
  - Page URL: `__________________________________`
  - Page snapshot (web.archive.org): `__________`
- [ ] **MAINNET_HARDENING.md (this file) frozen at the deploy commit hash.**
  - Commit hash: `__________________________________`
  - Counter-signed by: `_____________` (engineering) / `_____________` (governance)

---

## E. Concept-fidelity gates (the ones founders forget)

- [ ] **No new admin functions added since CONCEPT_AUDIT.md (2026-05-09) without explicit justification.**
  - Each new admin function has an ADR explaining (a) why it exists, (b) why an autonomous-rule alternative was rejected, (c) why it is acceptable on mainnet, and (d) how it will be retired.
  - ADR list: `__________`
- [ ] **All "TESTNET-OK / mainnet BLOCKER" items in CONCEPT_AUDIT.md resolved or formally deferred with reasoning.**
  - D-1 (three inconsistent VPP-digest encodings): ☐ resolved   ☐ deferred (reason: __________)
  - D-2 (UUPS upgradability): ☐ resolved (Timelock + revoke)   ☐ deferred
  - D-3 (Pause everywhere): ☐ resolved (Timelock OR autonomous breaker)   ☐ deferred
  - D-4 (Mutable fees / recipients): ☐ resolved (immutable OR Timelock)   ☐ deferred
  - D-5 (TEST_HOOK_ROLE): ☐ resolved (revoked + stripped/gated)   ☐ deferred — *deferral not acceptable*
  - D-6 (No 48h timelock on Governance): ☐ resolved   ☐ deferred — *deferral not acceptable*
  - D-7 (Proof-of-Wear not enforced): ☐ resolved   ☐ deferred (reason: __________)
- [ ] **CORE_THESIS.md re-read and signed off by Mag (Magomed Kiev) within 7 days of deploy.**
  - Re-read date: `__________`
  - Signature: `_____________`
- [ ] **CONCEPT_AUDIT.md re-run by an independent reviewer against the mainnet bytecode and the answer is "9 Aligned, 4 Drift, 0 Violations" — or better.**
  - Reviewer: `_____________`
  - Re-audit doc path: `__________`
  - Final score: `____ Aligned, ____ Drift, ____ Violations`

---

## Sign-off

This deployment may proceed only after every box above is ticked and every blank field is filled. The signers below attest that they have personally verified each item.

| Role | Name | Date | Signature |
|---|---|---|---|
| Engineering lead | `_____________` | `_____________` | `_____________` |
| Governance lead | `_____________` | `_____________` | `_____________` |
| Founder (Mag) | Magomed Kiev | `_____________` | `_____________` |
| Auditor (external) | `_____________` | `_____________` | `_____________` |

**Mainnet deploy tx hash (filled in last):** `__________________________________`
**Mainnet deploy block number:** `_____________`
**Mainnet deploy UTC timestamp:** `_____________`
