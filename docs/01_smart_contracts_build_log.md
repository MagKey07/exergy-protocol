# 01 — Smart Contracts Build Log (Phase 0 / MVP)

**Date:** 2026-05-08
**Author:** Turpal (HQ) — autonomous build pass
**Scope:** Five Solidity contracts + Hardhat scaffolding for Exergy Protocol testnet MVP.
**Source of truth:** `Exergy/05_System/CORE_THESIS.md`, `Exergy/01_Pitch/Technical_Blueprint.md` §2 + §5.

> WARNING: Every contract carries a top-of-file banner — "MVP testnet implementation. Production deployment requires security audit by OpenZeppelin or Trail of Bits." Do NOT ship to mainnet without that audit.

---

## Files created

### Contracts

| File | LOC | Notes |
|---|---|---|
| `contracts/XRGYToken.sol` | 70 | ERC-20 + EIP-2612 permit. Immutable (no proxy). One-shot `setMintingEngine`. |
| `contracts/MintingEngine.sol` | 381 | Core mint/halving/epoch/floating-index logic. UUPS upgradeable. |
| `contracts/OracleRouter.sol` | 221 | Trust boundary. Dual ECDSA verify (device + VPP). UUPS upgradeable. |
| `contracts/Settlement.sol` | 275 | Fee router + same-VPP / cross-VPP transfers. NO BURN. UUPS upgradeable. |
| `contracts/ProtocolGovernance.sol` | 184 | VPP registry + pause + 2-step ownership + UUPS. |

### Interfaces

| File | LOC |
|---|---|
| `contracts/interfaces/IXRGYToken.sol` | 47 |
| `contracts/interfaces/IMintingEngine.sol` | 111 |
| `contracts/interfaces/IOracleRouter.sol` | 112 |
| `contracts/interfaces/ISettlement.sol` | 108 |
| `contracts/interfaces/IProtocolGovernance.sol` | 69 |

### Tooling

| File | LOC |
|---|---|
| `hardhat.config.ts` | 80 |
| `package.json` | 36 |
| `.env.example` | 12 |
| `.gitignore` | 41 |

**Total Solidity:** ~1,498 LOC (1,131 implementation + 447 interfaces).
**Total project:** ~1,694 LOC including config.

---

## Architecture summary

```
                    ┌──────────────────────────┐
                    │   ProtocolGovernance     │  (UUPS, AccessControl, Pausable, Ownable2Step)
                    │   - VPP registry         │
                    │   - Managed contracts    │
                    │   - Emergency pause      │
                    └──────────────────────────┘
                                 │
       ┌─────────────────────────┼─────────────────────────┐
       │                         │                         │
┌──────▼──────┐         ┌────────▼────────┐       ┌────────▼─────────┐
│  XRGYToken  │◄────────│  MintingEngine  │◄──────│  OracleRouter    │
│  (immutable │  mint() │  (UUPS)         │ commit│  (UUPS)          │
│   ERC-20+   │         │  - halving      │       │  - dual ECDSA    │
│   permit)   │         │  - epoch        │       │  - device reg    │
└─────────────┘         │  - floating idx │       │  - replay guard  │
                        └────────┬────────┘       └──────────────────┘
                                 │ recordEnergyConsumption
                        ┌────────▼────────┐
                        │   Settlement    │  (UUPS)
                        │  - settleEnergy │
                        │  - crossVPP     │
                        │  - fee router   │
                        │  - NO BURN      │
                        └─────────────────┘
```

### One-shot wiring (post-deploy, in this order)

1. Deploy `XRGYToken` (immutable). Owner = deployer.
2. Deploy `MintingEngine` proxy → `initialize(token, admin, halvingThresholdTokens=1_000_000)`.
3. `XRGYToken.setMintingEngine(engineProxy)` → owner renounces.
4. Deploy `OracleRouter` proxy → `initialize(admin)`.
5. Deploy `Settlement` proxy → `initialize(admin, token, engine, feeRecipients)`.
6. `MintingEngine.setOracleRouter(routerProxy)`.
7. `MintingEngine.setSettlement(settlementProxy)`.
8. `OracleRouter.setMintingEngine(engineProxy)`.
9. Deploy `ProtocolGovernance` proxy, register all four addresses via `setManagedContract`.
10. Each VPP that wants minting fees collected approves `Settlement` for max uint on `XRGYToken`.

---

## Design decisions (deviations from spec, with rationale)

### 1. Halving math: lazy multi-step advance after each mint

**Spec:** "Era advances when totalSupply >= halvingThreshold * (era + 1). Initial threshold 1M tokens."

**Implementation:** `_checkAndAdvanceHalving()` runs *after* each mint and advances era as many times as the cumulative supply has crossed thresholds (while-loop, capped by `MAX_ERA = 64`). If a single huge mint crosses 3 boundaries, all 3 `HalvingTriggered` events fire in order; the *current* mint still uses the pre-mint rate to keep the call deterministic. Off-chain consumers can reconcile from the events.

**Why this is right for MVP:** Single-mint multi-cross is mathematically rare on a 24h epoch with reasonable kWh batches; the next batch will mint at the new rate. Recomputing within-call would require splitting the mint into multiple sub-mints with different rates — possible, but adds gas, complexity, and audit surface for a corner case that won't occur in pilot scale (160K kWh/day).

### 2. Mint rate as bit-shift, not fraction struct

`_rateForEra(era) = RATE_BASE_WEI >> era` where `RATE_BASE_WEI = 1e18`. Era 0 = 1e18 wei/kWh = 1.0 token/kWh. Era 1 = 5e17, era 2 = 2.5e17, … Hard-capped at era 64 where the rate underflows to 0 cleanly.

**Why this is right:** Halving is by-definition a power-of-2 division. Bit shift is exact, gas-cheap (~3 gas), and impossible to misconfigure. No precision loss until era 60 (where 1 kWh would mint < 1 wei, which the spec calls the "practical ceiling").

### 3. Floating index returns 0 when supply is 0

`getFloatingIndex()` returns 0 if `token.totalSupply() == 0` instead of reverting. Avoids breaking dashboards reading the value at genesis.

### 4. NO BURN — confirmed end-to-end

- `XRGYToken` does not implement `burn()` or `burnFrom()`.
- `Settlement.settleEnergy()` calls `safeTransferFrom(payer → provider)` for the principal. The token is NEVER destroyed.
- `Settlement.collectMintingFee()` and the fee path use `safeTransferFrom`/`safeTransfer` only.
- `MintingEngine.recordEnergyConsumption(kwh)` reduces `totalVerifiedEnergyInStorage` (kWh, integer) — it does NOT touch token supply.

This is enforced structurally: `IXRGYToken.mint` exists, no inverse function does.

### 5. Settlement collects fee BY APPROVAL, not from mint flow itself

The 1% minting fee is pulled by `Settlement.collectMintingFee(recipient, gross)` after `MintingEngine` mints to the VPP. The VPP must have a standing approval to Settlement.

**Alternative considered:** mint `gross - fee` to VPP and `fee` to Settlement directly. Rejected because:
- It splits the mint into two events, which makes the on-chain story muddier ("the energy receipt" should match the kWh exactly).
- It couples Token → Settlement at the contract level (Token would need to know who gets the fee).
- Approval-pull is the standard EVM pattern and lets a VPP opt out by simply not approving (in which case the engine's `try/catch` swallows the revert on testnet — see Limitations).

### 6. Single-owner admin (no 48h timelock yet)

Per task brief: "Timelock not required for MVP — single owner address." Each module uses `AccessControl` with `DEFAULT_ADMIN_ROLE` + role-specific permissions (UPGRADER / PAUSER / EPOCH_SEALER / DEVICE_REGISTRAR / FEE_MANAGER / GOVERNOR). Production swaps the admin holder for a `TimelockController` (48h per spec §10.3) without contract changes.

### 7. ECDSA over EIP-191 prefix (not EIP-712 yet)

OracleRouter uses `MessageHashUtils.toEthSignedMessageHash` — i.e. the `\x19Ethereum Signed Message:\n32` prefix used by `personal_sign`. This is the simplest integration path for the off-chain oracle simulator (Node.js `signMessage`). Production may upgrade to EIP-712 typed data for better wallet UX (visible struct fields when a human signs), but the dual-sig security guarantee is unchanged.

**VPP signature is over `keccak256(packetHash, deviceSignature)`.** This explicitly binds the VPP attestation to the device signature it co-validated. An attacker with a leaked VPP key cannot replay a VPP signature against a different device packet.

### 8. Replay protection at `OracleRouter` level

`_processed[packetHash]` is set BEFORE the external call to `MintingEngine.commitVerifiedEnergy` (CEI pattern). Each unique `(deviceId, kwh, timestamp, capacity, %, source, cycles)` tuple can be consumed exactly once.

### 9. `TEST_HOOK_ROLE` on MintingEngine — testnet only

`MintingEngine` exposes `adminSetTotalVerifiedEnergy`, `adminSetEra`, `adminSetHalvingThreshold`, `adminSetGenesisTimestamp` gated by `TEST_HOOK_ROLE`. These let QA fast-forward halvings, simulate consumption without a Settlement flow, and force epoch boundaries. The role MUST be revoked before mainnet — the build log flags this for the QA agent.

### 10. UUPS over Transparent proxy

Smaller deployment cost, easier upgrade mechanics, and matches OpenZeppelin's current default for new code. Implementation contracts inherit `UUPSUpgradeable` and gate `_authorizeUpgrade` on `UPGRADER_ROLE`. Each implementation calls `_disableInitializers()` in its constructor.

### 11. Storage gap reservations (`uint256[40] private __gap`)

Every UUPS contract reserves a 40-slot gap at the end of its storage layout. Future revisions can add fields without breaking proxy storage compatibility.

### 12. `IXRGYToken` extends both `IERC20` and `IERC20Permit`

So callers (Settlement, Engine, off-chain) get the full surface from one import without bringing in the OZ implementation contract.

### 13. Custom errors everywhere

No `revert("string")`. Saves ~50 gas per revert and gives ABIs structured error data.

---

## Known limitations (MVP vs production spec)

| # | Limitation | Production fix |
|---|---|---|
| 1 | No Chainlink External Adapter — DSO cross-validation is mocked (off-chain oracle simulator just sends dual-signed packets). | Phase 1: Chainlink `FunctionsClient` calls a hosted adapter that compares device kWh to DSO meter readings; >20% drift → reject epoch. |
| 2 | Halving multi-cross within a single mint uses pre-mint rate for full batch. | If pilot data shows it ever matters, split the mint inside `commitVerifiedEnergy` into per-era sub-mints. |
| 3 | Minting fee silently no-ops if VPP hasn't approved Settlement (try/catch). | Production: hard-revert. Require approval as part of VPP onboarding gate in `ProtocolGovernance`. |
| 4 | `ProtocolGovernance.pauseProtocol()` only pauses *itself*. Each module pauses independently via its own PAUSER_ROLE. | Add a shared `IPausable.pauseAll()` fan-out, OR make modules read the governance pause flag on every state-changing call. |
| 5 | No 48h timelock — admin is a single EOA. | Replace `DEFAULT_ADMIN_ROLE` holder with `TimelockController(48h)` per spec §10.3. |
| 6 | No on-chain fee-stream withdrawal helpers (treasury/team/etc collect into recipient addresses directly). | If recipients are smart contracts (vesting, multi-sig), they handle accounting on receipt. Production may add a `claim()` helper if recipients are EOAs that prefer pull semantics. |
| 7 | `TEST_HOOK_ROLE` exists. | MUST be revoked before mainnet. Mainnet deploy script should refuse to deploy if test hook role is granted to any non-zero address. |
| 8 | EIP-191 signing (vs EIP-712). | Phase 1: typed data for better wallet UX in human-signed flows (VPP cloud is HSM-backed, so this is cosmetic). |
| 9 | No on-chain `cumulativeCycles` consistency check (Proof-of-Wear flagging is left to off-chain oracle layer per spec §5.6). | Add an on-chain anomaly threshold: reject when `cumulativeCycles - lastCycles > storageCapacity * 2 / kwhPerCycle` etc. |
| 10 | `MintingEngine.commitVerifiedEnergy` reverts if minted amount = 0. After era 59ish a 1 kWh batch underflows. | Aggregate small mints off-chain before submission (oracle simulator can batch); or migrate kWh integer to `kwh * 1e18` fixed-point. |
| 11 | No DSO cross-reference in `OracleRouter.submitMeasurement` — packet is accepted purely on dual-sig. | Phase 1: Chainlink Functions call before forwarding to engine, reverting on disagreement. |
| 12 | No "consecutive failure auto-deactivate" (spec §3 failure handling: "3 consecutive failures → VPP auto-deactivated"). | Add a `failureCount` mapping; auto-flip `active=false` at threshold. |
| 13 | XRGYToken deployer is the temporary owner who wires the engine. Forgotten renunciation = silent centralization. | Deploy script must call `renounceOwnership` automatically right after `setMintingEngine`. |

---

## Invariants to test (for the QA agent)

These should be expressed as Hardhat / Foundry tests:

**Token:**
- I-T1: After `setMintingEngine`, calling `mint` from any address ≠ engine reverts with `NotMintingEngine`.
- I-T2: `setMintingEngine` cannot be called twice (reverts `MintingEngineAlreadySet`).
- I-T3: Token has no burn surface — every external function preserves `totalSupply` *or* increases it.
- I-T4: ERC-2612 `permit` works (signature path).

**MintingEngine — halving:**
- I-M1: With `halvingThresholdTokens=1`, after a 1 kWh mint at era 0, era advances to 1; next 1 kWh mints 0.5 token.
- I-M2: A mint of size N*halvingThreshold immediately advances era by N (multi-cross via while-loop).
- I-M3: `currentMintRateWeiPerKwh()` returns `1e18 >> era` exactly.
- I-M4: At era ≥ 60, mint reverts with `MintAmountZero` for small batches.
- I-M5: Total minted equals `sum(epoch.totalTokensMinted)` for all epochs.

**MintingEngine — floating index:**
- I-M6: `getFloatingIndex()` returns 0 when totalSupply is 0.
- I-M7: After mint of 1 kWh at era 0, index = 1e18 (1 kWh in storage / 1 token, scaled by 1e18).
- I-M8: After `recordEnergyConsumption(k)`, `totalVerifiedEnergyInStorage` decreases by k; token supply unchanged.

**MintingEngine — access:**
- I-M9: `commitVerifiedEnergy` reverts unless caller is `oracleRouter`.
- I-M10: `recordEnergyConsumption` reverts unless caller is `settlement`.
- I-M11: `setOracleRouter` / `setSettlement` are one-shot (revert on second call).

**OracleRouter — dual signature:**
- I-O1: Valid (device + VPP) signatures → mint succeeds, packet hash recorded.
- I-O2: Missing VPP signature (any garbage bytes) → revert `InvalidVPPSignature`.
- I-O3: Missing device signature → revert `InvalidDeviceSignature`.
- I-O4: Replayed packet → revert `DuplicateMeasurement`.
- I-O5: Unregistered device → revert `DeviceNotRegistered`.
- I-O6: Deactivated device → revert `DeviceInactive`.
- I-O7: Backdated > 72h → revert `TimestampOutOfWindow`.
- I-O8: Future-dated > 5min → revert `TimestampOutOfWindow`.

**Settlement — no burn + fees:**
- I-S1: After `settleEnergy(provider, A, k)`, provider receives exactly A; payer's balance decreased by `A + A * 25/10_000`. Token totalSupply unchanged.
- I-S2: Fees distribute Treasury/Team/Ecosystem/Insurance per 40/20/25/15 with rounding remainder going to Insurance.
- I-S3: `kwhConsumed > 0` triggers `mintingEngine.recordEnergyConsumption`.
- I-S4: `crossVPPSettle` does NOT touch `totalVerifiedEnergyInStorage`.
- I-S5: `collectMintingFee` reverts unless caller is `mintingEngine`.
- I-S6: Setting `settlementFeeBps > 1000` reverts with `FeeBpsTooHigh`.

**Governance:**
- I-G1: `registerVPP` for already-registered id reverts.
- I-G2: `setVPPActive(false)` flips `isActiveVPPOperator(addr)` to false.
- I-G3: Two-step ownership transfer: `transferOwnership` → `acceptOwnership` swap also rotates `DEFAULT_ADMIN_ROLE`.

**End-to-end:**
- I-E1: Full flow — register VPP, register device, sign packet (hardhat ethers), submit, expect mint event, expect VPP balance increase, expect floating index update.

---

## Next steps for QA agent

1. **Run `npm install`** (top of `MVP/`).
2. **`npm run compile`** to verify all contracts type-check against OZ ^5.0.
3. **Write tests in `test/`:**
   - `test/XRGYToken.test.ts` — invariants I-T1 … I-T4.
   - `test/MintingEngine.test.ts` — I-M1 … I-M11. Use `adminSetEra` / `adminSetHalvingThreshold` test hooks to drive halving paths.
   - `test/OracleRouter.test.ts` — I-O1 … I-O8. Generate signatures with `wallet.signMessage(ethers.getBytes(packetHash))`.
   - `test/Settlement.test.ts` — I-S1 … I-S6. Verify `totalSupply` invariance after each settle.
   - `test/ProtocolGovernance.test.ts` — I-G1 … I-G3.
   - `test/E2E.test.ts` — I-E1: register → sign → submit → mint → settle → verify floating index.
4. **Coverage target:** 95%+ statement, 90%+ branch.
5. **Gas snapshot:** run `hardhat-gas-reporter` against the e2e flow and add to PROGRESS.md.
6. **Slither static analysis** (optional but recommended): `slither contracts/`.
7. **Deployment script** (`scripts/deploy.ts`) must enforce the wiring order above and fail-fast if `setMintingEngine` succeeds twice. Owner of `XRGYToken` must call `renounceOwnership()` automatically after wiring.
8. **Pre-mainnet checklist** (DO NOT skip):
   - Revoke `TEST_HOOK_ROLE` from every holder.
   - Confirm `XRGYToken.owner()` is `address(0)`.
   - Replace single-EOA admin with `TimelockController(48h)`.
   - Run an external audit (OpenZeppelin / Trail of Bits, $30-50K budget per blueprint §6).

---

## CORE_THESIS check

Before sign-off I re-read CORE_THESIS.md. Code matches:
- Tokens come ONLY from verified physical energy (OracleRouter → MintingEngine).
- No pre-mine, no sale function exists in any contract.
- Halving is by token count, threshold-driven, physics-not-adoption.
- NO burn — Settlement only transfers; floating index self-regulates via `totalVerifiedEnergyInStorage` deltas.
- The token IS the receipt; it's not the investor's asset (investor buys equity in Key Energy, Inc., not in this contract layer).

If anyone reading this build log finds a place where the code says "buy tokens", "sell tokens", "burn", or treats the token as a security — flag it immediately. None should exist.

---

*Built by Turpal (HQ), 2026-05-08. Auto-mode autonomous build pass.*
