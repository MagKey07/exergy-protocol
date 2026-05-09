# Dashboard — Build Log (Phase 0)

**Agent:** Frontend (claude-opus-4.7)
**Date:** 2026-05-08
**Stack:** React 18 + TypeScript (strict) · Vite · TailwindCSS + shadcn/ui · wagmi v2 + viem · RainbowKit · Recharts · React Router v6
**Network:** Arbitrum Sepolia (ChainID 421614)
**Output:** `Exergy/MVP/dashboard/`

---

## Files created

### Root config (8 files)

| File | Lines | Purpose |
|---|---:|---|
| `package.json` | 48 | Pinned versions for wagmi v2, RainbowKit, Recharts, Tailwind, Vite, etc. |
| `vite.config.ts` | 30 | `@/` path alias, dev port 5173, manual chunks (react / web3 / charts). |
| `tsconfig.json` | 30 | Strict mode + `noUnusedLocals` + `noImplicitOverride` + `@/*` path. |
| `tsconfig.node.json` | 12 | Vite config typecheck. |
| `tailwind.config.js` | 113 | Institutional palette via HSL CSS vars; serif/sans/mono stacks; tabular nums. |
| `postcss.config.js` | 6 | Tailwind + autoprefixer. |
| `index.html` | 18 | `class="dark"` default, theme color, meta description. |
| `.gitignore` + `.env.example` | 51 + 23 | Standard ignores; commented env template. |

### Bootstrap (3 files)

| File | Lines | Purpose |
|---|---:|---|
| `src/main.tsx` | 54 | Provider order: Wagmi → QueryClient → RainbowKit (dark theme tuned to brand) → Router → App. |
| `src/App.tsx` | 44 | Top-level layout, 5 routes, footer with chain id. |
| `src/index.css` | 106 | Design tokens, `panel`, stat utilities, recharts tooltip overrides, RainbowKit theming hooks. |
| `src/vite-env.d.ts` | 15 | Typed `ImportMetaEnv`. |

### Lib (3 files)

| File | Lines | Notes |
|---|---:|---|
| `src/lib/env.ts` | 41 | Typed env access; address validation falls back to zero with `console.warn` instead of throwing — keeps the dashboard demo-able pre-deploy. |
| `src/lib/contracts.ts` | 333 | Hand-written narrow ABIs for XRGYToken / MintingEngine / OracleRouter / Settlement. Plus `HALVING_SCHEDULE` constant. |
| `src/lib/utils.ts` | 102 | `cn`, `shortAddress`, `formatToken`, `formatKwh`, `formatFloatingIndex`, `formatEraRate`, `formatBps`, `relativeTime`, `sourceTypeLabel`. |
| `src/wagmi.ts` | 56 | RainbowKit `getDefaultConfig`, single chain (arbitrumSepolia), `contractsConfigured()` predicate. |

### shadcn/ui primitives (7 files, copy-paste, restyled)

| File | Lines |
|---|---:|
| `button.tsx` | 61 |
| `card.tsx` | 74 |
| `badge.tsx` | 36 |
| `input.tsx` | 27 |
| `table.tsx` | 79 |
| `tabs.tsx` | 56 |
| `dialog.tsx` | 101 |

All re-skinned away from shadcn defaults (no shadow, hairline borders, monospace tabular numbers in inputs, uppercase `tracking-[0.12em]` table headers).

### Shared components (5 files)

| File | Lines | Purpose |
|---|---:|---|
| `Header.tsx` | 96 | Serif "EXERGY" logo, nav, network indicator with live-pulse dot, RainbowKit ConnectButton. Surfaces "Contracts pending" and "Operator session" badges. |
| `Stat.tsx` | 60 | Numbers-as-hero tile, hero/default sizes, loading skeleton. |
| `PageHeader.tsx` | 38 | Eyebrow → serif title → subtitle → actions slot. |
| `EmptyState.tsx` | 30 | Centered panel for "connect wallet" / no-data states. |
| `ContractsBanner.tsx` | 27 | Phase-0 banner when env addresses are zero. |

### Hooks (5 files)

| Hook | Lines | Behaviour |
|---|---:|---|
| `useFloatingIndex` | 41 | `getFloatingIndex()` → 1e18-scaled bigint. 60s refetch. |
| `useEraRate` | 73 | Multicall (`getCurrentEra`, `getCurrentRate`); enriches with `HALVING_SCHEDULE` row for next-halving hint. |
| `useVPPDevices(vpp)` | 123 | `getLogs` for `DeviceRegistered` filtered by VPP, then `MeasurementVerified` to populate "last seen". Replaceable with subgraph in Phase 1. |
| `useProtocolStats` | 61 | One multicall: totalSupply / symbol / energyInStorage / energyEverVerified / currentEpoch / epochLength. |
| `useMintEvents({vpp?, limit?})` | 94 | `TokensMinted` events. Network-wide on Overview, per-VPP on MyVPP. |

### Pages (5 files)

| Page | Lines | Surfaces |
|---|---:|---|
| `Overview.tsx` | 226 | Hero: total $XRGY, floating index, current era. Recent epoch mints feed (12 rows). Active VPPs derived from mint events. |
| `MyVPP.tsx` | 207 | Wallet-gated. Hero $XRGY balance, devices count, recent kWh sum. Device fleet + recent mints tables. |
| `Devices.tsx` | 205 | Network-wide registry with search/filter. Note about Proof-of-Wear cycles awaiting indexer. |
| `Settlement.tsx` | 323 | Two tabs (P2P / Cross-VPP). Live fee preview, hashed memo, balance check, write tx + wait-for-receipt. |
| `Tokenomics.tsx` | 271 | Two charts (log mint rate by era, cumulative energy area), full halving schedule table, "why halving" + "why no token sale" copy panels. |

### Documentation

| File | Lines |
|---|---:|
| `README.md` | 111 |

---

## Totals

- **38 source files**
- **3,428 total lines** including configs and CSS
- ~2,900 lines of executable React/TypeScript

---

## Component architecture decisions

1. **Hooks return raw `bigint` + `formatX()` at call-site.** Resisted the temptation to return pre-formatted strings from hooks. Formatting belongs at the leaf — keeps math composable, lets future graphs/exports use the raw value.
2. **`getLogs` over subgraph for Phase 0.** Documented as the swap point. The hook signatures already match what a subgraph query would return — `MintEvent[]`, `DeviceRow[]` — so Phase 1 is a one-file change per hook.
3. **Single accent color, single live-dot animation.** The CORE_THESIS warns against generic AI / crypto aesthetics. One muted-mint accent + one slow pulse is the entire animation budget.
4. **No global state library.** wagmi + react-query already handle every async piece; adding Redux/Zustand would be cosplay.
5. **Strict mode TypeScript with `noUnusedLocals` + `noUnusedParameters`** — catches dead code before review.
6. **Manual chunks in vite config** so first paint doesn't pull Recharts on Overview before Tokenomics is opened.
7. **Path alias `@/*` → `src/*`** in both `tsconfig.json` and `vite.config.ts`.
8. **Tailwind theme via CSS variables** (HSL channels) — gives us a one-line dark-only/light-future switch without rewriting palette.
9. **`contractsConfigured()` gate.** Banner + empty states render gracefully even when `VITE_*_ADDRESS` are still zero — important for Mag to demo before Smart Contracts agent finishes.

---

## What's functional vs placeholder

### Functional (assuming addresses wired)

- All on-chain reads (balances, supply, era, rate, floating index, energy stocks).
- Recent epoch mints (network + per-VPP).
- VPP device fleet reconstruction from events.
- Network-wide device registry with search.
- Settlement write flow (P2P + cross-VPP) with fee preview, balance check, memo hash, wait-for-receipt.
- Halving schedule chart + cumulative energy area chart (static schedule values).
- Wallet connect via RainbowKit (MetaMask injected + WalletConnect v2).
- Dark theme, responsive layout (mobile collapses nav, hides "operator session" badge).

### Mocked / awaiting

| Item | Reason | Resolution |
|---|---|---|
| `cumulativeCycles` column on Devices | The `cumulative_cycles` field lives inside the `MeasurementPacket` struct passed into `submitMeasurement`. The `MeasurementVerified` event topics in the current `IOracleRouter.sol` interface don't include it. | Either widen the event in the contract, or surface via subgraph that decodes the calldata. |
| Active VPPs list on Overview | No `VPPRegistered` event surfaced yet — derived from mint event uniqueness. | Wire to `ProtocolGovernance.sol` registry events when contracts agent finalizes. |
| Per-VPP "last seen" wall-clock on Overview | Block timestamps not pulled. | Phase 1: include block→timestamp lookup in the indexer. |
| Floating index time-series chart | Needs historical samples — only the current value is available via `getFloatingIndex()`. | Phase 1 indexer: snapshot at each epoch settlement. |
| Per-device telemetry stream | Phase 0 surfaces last measurement; no live MQTT/WebSocket. | Phase 1: add a `useDeviceTelemetry(deviceId)` hook backed by either oracle adapter websocket or subgraph `epoch_data` polling. |

---

## Integration points with smart contracts

When the contracts agent compiles `XRGYToken.sol`, `MintingEngine.sol`, `OracleRouter.sol`, `Settlement.sol`:

1. **Drop ABIs into `src/lib/contracts.ts`.** The `xrgyTokenAbi`, `mintingEngineAbi`, `oracleRouterAbi`, `settlementAbi` constants there are intentionally narrow — the dashboard hooks only reference the function names listed in the README. A wider ABI is fully forward-compatible.
2. **Set `VITE_*_ADDRESS` env vars** to deployed proxy addresses on Arbitrum Sepolia. The "Contracts pending" banner disappears automatically.
3. **Verify event topic shapes match.** The hooks parse via `parseAbiItem(...)` — if the deployed contract widens an event (e.g. adds `cumulativeCycles` to `MeasurementVerified`), update the `parseAbiItem` string in `useVPPDevices.ts` and `Devices.tsx`.
4. **`Settlement.sol` write fns:** the dashboard expects `settle(to, amount, memoHash)` and `settleCrossVPP(toVPP, to, amount, memoHash)`. If the final contract names them differently (e.g. `settleP2P`, `settleAcrossVPPs`), rename in `settlementAbi` + the two `writeContract` calls in `Settlement.tsx`.
5. **Approval flow.** Settlement currently assumes the operator transfers from their own balance directly via the Settlement contract. If the contract pulls via `transferFrom`, the form needs to add an `approve` step before `settle` — the wagmi `useWriteContract` is already imported, so it's a small addition.

---

## Visual / tone audit (against CORE_THESIS)

- ❌ "DePIN dashboard" frame: avoided. Page subtitles ground every number in physical reality ("verified physical energy storage", "Proof-of-Charge", "energy density per token").
- ❌ Crypto-neon: avoided. Single muted-mint accent, hairline borders, no gradients, no glow.
- ❌ Speculation language: avoided. Settlement copy says "Settle in $XRGY", "Pay participants in the energy they helped store" — never "swap" or "trade".
- ✅ Equity vs token clarity: Tokenomics page closes with "Investors hold equity in Key Energy, Inc. (Delaware C-Corp); $XRGY is never sold." Direct quote of the thesis.
- ✅ Halving framing: "independent of adoption, dependent on physics" — direct from CORE_THESIS.
- ✅ No-burn rationale: explicitly called out on Settlement page in the closing note.

---

## Next steps for the next agent picking this up

1. Run `npm install` (deferred per instructions).
2. Run `npm run typecheck` — should pass cleanly under strict mode.
3. Run `npm run dev` — dashboard opens at http://localhost:5173 in "Contracts pending" mode.
4. Once contracts deploy, fill in `.env`, restart Vite, all numbers light up.
5. For the Phase 1 indexer integration, the swap points are documented inline in `useVPPDevices.ts`, `useMintEvents.ts`, and the README "What's mocked" section.

— Frontend agent.

---

## 2026-05-09 — D-9 fix: Settlement page rewired to actual Settlement.sol ABI

**Agent:** Turpal (HQ Consigliere) — concept-fidelity drift fix follow-up to CONCEPT_AUDIT.md.
**Trigger:** Audit drift D-9. Dashboard called `settle(to, amount, memoHash)` and `settleCrossVPP(toVPP, to, amount, memoHash)` — neither function exists on the deployed contract. Real surface is `settleEnergy(provider, tokenAmount, kwhConsumed)` and `crossVPPSettle(receiver, counterpartyVPPId, tokenAmount)`.

### Files changed

| File | Lines (new) | Change |
|---|---|---|
| `dashboard/src/lib/contracts.ts` | 383 (was 334) | Replaced narrow Settlement ABI: `settle`/`settleCrossVPP` removed; `settleEnergy`, `crossVPPSettle`, `mintingFeeBps`, `feeRecipients` view added; events `EnergySettled`, `CrossVPPSettled`, `FeesDistributed` replace the speculative `Settled` aggregate. ABI now mirrors `contracts/Settlement.sol` + `contracts/interfaces/ISettlement.sol` verbatim. |
| `dashboard/src/pages/Settlement.tsx` | 361 (was 324) | Rewired both writeContract call sites: `settle` → `settleEnergy(provider, tokenAmount, 0n)` for intra-VPP (kwhConsumed = 0 because this is an operator manual form, not the metering pipeline); `settleCrossVPP` → `crossVPPSettle(receiver, counterpartyVPPId, tokenAmount)` for cross-VPP. `memoHash` is no longer passed on-chain — kept in UI as off-chain bookkeeping only. `counterpartyVPPId` (bytes32) is derived deterministically as `keccak256(toLowerCase(toVpp))`. Updated fee-on-top semantics in the preview (recipient receives full principal; payer is debited principal + fee; insufficient-balance check now uses `principal + fee`). Header subtitle and memo hint updated to match new contract semantics. |

### Behavioural changes visible to operators

- **Recipient receives the full amount, not net-of-fee.** Previous preview said "Recipient receives = amount − fee"; the on-chain reality is the recipient gets the full `tokenAmount` and the payer pays the fee on top. Preview now shows "Recipient receives" (= principal) + "Fee (X bps, on top)" + "Total debited from you" (= principal + fee).
- **Approval surface changed.** Operators must approve `tokenAmount + fee` to Settlement before submitting. The form does not yet do an `approve` call (still relies on the operator having a standing approval); flagged below.
- **Memo is no longer on-chain.** The contract has no memo parameter. The UI still hashes the memo locally for operator records, but it is never sent in the transaction.
- **Cross-VPP form takes the counterparty VPP address as before** but it now feeds into a derived `bytes32 counterpartyVPPId` digest passed to the contract. Off-chain registry can map digest → VPP name.

### Disagreements with audit

- None. Audit's claimed Settlement ABI matches the contract verbatim (verified by reading `Settlement.sol:129-179` and `ISettlement.sol:73-81`).

### Open issues

1. **Approval flow still missing.** Settlement form assumes operator has pre-approved `tokenAmount + fee`. Should add a wagmi `approve` step that fires when `allowance < principal + fee`. Out of scope for this drift fix; tracked as a separate UX gap for next sprint.
2. **`useSettlements` indexer hook (if/when added) must subscribe to `EnergySettled` and `CrossVPPSettled`, not the obsolete `Settled` event** that earlier scaffolding alluded to. The new ABI's events match the contract — any historical-tx page can plug straight in.
3. **Counterparty VPP id is a client-side hash of the address.** Acceptable for Phase 0 demo, but the real off-chain VPP registry should publish the canonical `bytes32 vppId` for each VPP and the form should accept that directly (or both).
4. **No on-chain memo means the operator has no audit anchor for an off-chain invoice number** if their bookkeeping needs one. Two paths if storytelling demands it: (a) extend `Settlement.sol` events with a `memoHash` field — adds storage-free indexed metadata; (b) emit a separate side-channel log via a `MemoLogger` contract. Both are sprint-extension work.

— Turpal (HQ).
