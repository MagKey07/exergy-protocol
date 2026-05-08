# QA / DevOps Build Log — 2026-05-08

Owner: QA/DevOps agent (parallel to smart contracts agent).
Scope: test suite + deployment scripts + architecture docs.
Status: written. Tests do not run yet — contracts are still in flight.

---

## Files created

### Tests (`test/`) — 1666 lines

| File | Lines | Purpose |
|---|---|---|
| `test/helpers/fixtures.ts` | 206 | `loadFixture` factories: `deployFullSystem`, `deployTokenOnly`. Constants for halving, fees, fee split. |
| `test/helpers/signatures.ts` | 94 | MeasurementPacket encoding + dual-signature helpers (device + VPP cloud). |
| `test/XRGYToken.t.ts` | 222 | ERC-20, ERC-2612 permit, mint restriction, no-burn, one-shot setter, zero-address checks. |
| `test/MintingEngine.t.ts` | 330 | Halving math (era 0→1→2), floating index, epoch boundaries, anti-replay, access control. |
| `test/OracleRouter.t.ts` | 250 | Single-sig REJECT, dual-sig ACCEPT, device registry, deactivation, anti-replay, wrong-key paths. |
| `test/Settlement.t.ts` | 198 | 0.25% settlement fee, 1% mint fee, 40/20/25/15 distribution, NO BURN. |
| `test/ProtocolGovernance.t.ts` | 156 | VPP register/deactivate, pause, parameter timelock, two-step ownership. |
| `test/integration/EndToEnd.t.ts` | 210 | Register → mint → transfer → settle → redeem. Asserts NO-BURN invariant across full lifecycle + Anti-Simulation Lock. |

### Deployment scripts (`scripts/`) — 492 lines

| File | Lines | Purpose |
|---|---|---|
| `scripts/deploy.ts` | 203 | Deploys all 5 contracts in topological order, wires one-shot setters, persists `deployments/<network>.json` + `deployments/latest.json`. UUPS proxies via `@openzeppelin/hardhat-upgrades`. |
| `scripts/verify.ts` | 69 | Iterates address book, runs `hardhat verify` for each contract + UUPS implementation. Tolerates "Already Verified". |
| `scripts/register-vpp.ts` | 41 | Admin: register a new VPP via `ProtocolGovernance.registerVPP`. Reads addr book. |
| `scripts/seed-test-data.ts` | 119 | Generates 3 mock VPPs × 5 devices, registers them, persists private keys to `deployments/seed-<network>.json` for the oracle simulator. |
| `scripts/upgrade.ts` | 60 | UUPS upgrade for any non-token contract. Refuses to upgrade XRGYToken (per spec §2.1). Patches address book. |
| `deployments/.gitkeep` | 0 | Placeholder. |

### Documentation (`docs/`) — 534 lines

| File | Lines | Purpose |
|---|---|---|
| `docs/00_ARCHITECTURE.md` | 124 | Single-page system overview: components, data flow, trust boundaries, testnet vs production. |
| `docs/04_DEPLOYMENT.md` | 164 | Step-by-step: prereqs → install → deploy → verify → seed → dashboard → simulator → e2e. |
| `docs/05_SECURITY.md` | 97 | Honest threat model. What we defend on testnet. What's out of scope until audit. Pre-mainnet checklist. |
| `docs/06_INVESTOR_DEMO_SCRIPT.md` | 149 | Minute-by-minute 5-min demo: register VPP, watch mint, settle P2P, see floating index dynamic. |
| `docs/07_qa_devops_build_log.md` | (this file) | Build log + open issues. |

**Grand total:** 2692 lines across 17 files.

---

## Coverage estimate

Tests are written against the SPEC (`Technical_Blueprint.md` §2-5) and the interface stubs in `contracts/interfaces/`. Coverage estimates assume the contracts implement those interfaces faithfully.

| Contract | Branches | Statements | Notes |
|---|---|---|---|
| **XRGYToken** | ~95% | ~95% | All branches: standard ERC-20, permit (valid/expired/wrong-signer), mint restriction, one-shot setter, no-burn assertion, zero-address checks. |
| **MintingEngine** | ~80% | ~85% | Era 0/1/2 transitions, halving event, floating index, epoch rollover, access control on `commitVerifiedEnergy` and `recordEnergyConsumption`, energy-underflow revert. Era 3+ paths exercised by extension; era-boundary mid-mint split-rate is a TODO if the contracts agent implements that variant. |
| **OracleRouter** | ~85% | ~90% | Dual-sig accept, single-sig reject (both directions), device registry CRUD, deactivation, replay rejection, wrong-key paths, unregistered device, MintingEngine wiring. Chainlink External Adapter path is mocked (Phase 1). |
| **Settlement** | ~75% | ~80% | P2P settle with 0.25% fee, fee distribution sum check, redemption with 1% fee + storage decrement, NO-BURN invariant, access control on setFeeReceivers. Cross-VPP redemption resolution may need a registry path the spec doesn't pin down — see open issue #2. |
| **ProtocolGovernance** | ~70% | ~75% | VPP register/deactivate, pause/unpause, parameter timelock proposal + execution, two-step ownership. The exact timelock duration is asserted only as `>0` because MVP testnet may use a shorter duration than 48h for demo speed. |
| **End-to-end (integration)** | n/a | full path | Single happy-path test + single Anti-Simulation Lock attempt + 5-tick mass-mint NO-BURN check. |

Targeted coverage: **80%+ across the suite once contracts land**. Likely higher on token + oracle (smaller surface), lower on Settlement until exact ABI is committed.

---

## Demo runtime estimate

| Phase | Time |
|---|---|
| Pre-flight (deploy + dashboard + simulator running) | ~30 min before call |
| Demo proper (frame → dashboard → tx on Arbiscan → register VPP → P2P settle → redemption → close) | **5 minutes** |
| Q&A | 5–15 min, no preset budget |
| Total wall-clock for the investor | 10–20 min |

The 5-minute target is achievable IF the simulator is already producing events. The hard part is the pre-flight, not the demo itself.

---

## Open issues / TODO for next iteration

### Blocking (cannot run tests without)

1. **Smart contracts must land.** Tests are SPEC-driven; they will fail on `Cannot find artifact "MintingEngine"` until the contracts agent commits implementations. Expected names: `XRGYToken`, `MintingEngine`, `OracleRouter`, `Settlement`, `ProtocolGovernance`.
2. **`hardhat.config.ts` missing.** The repo doesn't yet have a Hardhat config wired for ethers v6 + OZ upgrades + arbitrumSepolia network. Contracts agent or a separate config task must add it. Suggested deps: `hardhat`, `@nomicfoundation/hardhat-toolbox`, `@openzeppelin/hardhat-upgrades`, `@openzeppelin/contracts`, `@openzeppelin/contracts-upgradeable`.
3. **`tsconfig.json` for tests.** Standard Hardhat TS config — module=commonjs, target=es2022.

### Non-blocking (refinements)

4. **Settlement ABI ambiguity.** The spec describes "redemption" without pinning down whether the energy provider is resolved by an on-chain VPP-membership registry, by msg.sender's counterparty, or by an explicit address argument. Settlement.t.ts treats the consumer as the source and asserts only the supply/storage invariants. When the contract is committed, the test may need a one-line tweak to assert provider's balance.
5. **MintingEngine split-rate halving.** If the contracts implementation splits a mint that crosses a halving boundary into pre-rate + post-rate components (rather than applying the full mint at the new rate), the boundary tests assert a range (≥ 50, < 100) rather than an exact value. Tighten once the contracts agent fixes the convention.
6. **Demo helper scripts referenced by docs.** `scripts/demo-settle.ts` and `scripts/demo-redeem.ts` are referenced in `06_INVESTOR_DEMO_SCRIPT.md` but not yet written. Trivial to add — would be 30-line wrappers over `Settlement.settle` / `Settlement.recordRedemption`. Add in next iteration.
7. **Coverage harness.** `npx hardhat coverage` requires `solidity-coverage` plugin. Add to dependencies.
8. **Foundry suite.** README mentions Foundry for gas optimization, but no `foundry.toml` written. Defer to gas-tuning iteration after contracts stabilize.
9. **Dashboard `deployment.json` consumer.** Dashboard scaffold is empty; whoever builds it must read `public/deployment.json` per the deploy script's contract.
10. **Oracle simulator wiring.** Simulator scaffold is in place (`oracle-simulator/package.json` exists). The actual `index.ts` that reads `seed-<network>.json` and submits packets must be written by the simulator agent.
11. **CI.** No GitHub Actions yet. Recommended: lint + compile + test on every push, coverage gate at 75% (lower than typical 80% because some surface is interface-stub sensitive).
12. **`.env.example` at MVP root.** Mentioned in `04_DEPLOYMENT.md`, not committed. Add: `DEPLOYER_PRIVATE_KEY`, `ARBITRUM_SEPOLIA_RPC`, `ARBISCAN_API_KEY`, `GOVERNOR_ADDRESS`, fee receiver addresses.

### Documentation polish

13. Address-book file format is implicit. If the dashboard or simulator needs a different schema (e.g. flat key/value vs nested `contracts.*`), align all three at once.
14. `06_INVESTOR_DEMO_SCRIPT.md` references a `?demo=fast-halving` URL parameter — this is a hand-wave; if we want a fast-halving demo network, deploy a second instance with a 1000-token halving threshold and document it explicitly.

---

## Honest self-assessment

What's strong:

- The end-to-end test asserts the four hardest invariants in one place: dual-signature requirement, halving math, fee distribution sum, NO-BURN. If that test passes, the system works.
- The deploy script is idempotent in terms of address-book output (it overwrites `latest.json`) but NOT idempotent in terms of contract state (a re-deploy creates a new XRGYToken). That's correct for testnet — production never re-deploys.
- The security doc is honest. It explicitly says "do not deploy this to mainnet". Investors who read it will trust the team more, not less.

What's weak (until the contracts agent commits):

- Tests assume specific custom error names (`NotMintingEngine`, `EnergyUnderflow`, etc.) that match the interfaces. If the contracts use plain `revert("...")` strings instead of custom errors, the assertions need adjustment.
- The signature scheme assumes EIP-191 prefixed personal_sign. If the contracts use raw ECDSA over the digest, `signatures.ts` swaps `signMessage` for `Wallet.signingKey.sign(digest)`. Trivial change, isolated to one file.
- Settlement tests assume a method signature (`settle(from, to, amount)`, `recordRedemption(consumer, amount, kwh)`) that I'm proposing, not reading from a stub. Settlement interface is the highest source of risk for tests-vs-impl mismatch.

---

*End of build log. Hand off to contracts agent for implementation pass.*
