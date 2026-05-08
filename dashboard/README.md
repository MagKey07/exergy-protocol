# Exergy Dashboard

Operator + observer interface for the Exergy Protocol. Phase 0 (Arbitrum Sepolia testnet).

This is **not** "another DePIN dashboard". $XRGY is a receipt for physically stored kWh — a sectoral monetary unit. The dashboard surfaces the live state of that monetary precedent: total supply, floating index, current era, halving progress, settlement flows.

---

## Stack

- React 18 + TypeScript (strict)
- Vite
- TailwindCSS + shadcn/ui primitives (Button, Card, Badge, Tabs, Table, Input, Dialog)
- wagmi v2 + viem for chain reads/writes
- @rainbow-me/rainbowkit for wallet connect
- Recharts for halving / supply curves
- React Router v6

Visual direction: institutional dark theme, Stripe-density layout, Etherscan-style tables, monospace numbers as the hero. No neon, no rainbow gradients, no chart-junk.

---

## Setup

```bash
cd MVP/dashboard
cp .env.example .env
# fill in VITE_*_ADDRESS once contracts are deployed
# get a free WalletConnect project id from https://cloud.walletconnect.com
npm install
npm run dev    # http://localhost:5173
```

`npm run build` produces a static bundle in `dist/` that can be served from any CDN (Vercel, Cloudflare Pages, S3+CloudFront).

The dashboard renders gracefully when contract addresses are still zero — observers see a "contracts pending" banner instead of broken zero-state. As soon as `VITE_*_ADDRESS` env vars are populated, all reads come alive without a code change.

---

## Pages

| Route | File | Purpose |
|---|---|---|
| `/` | `src/pages/Overview.tsx` | Network-wide state. Total $XRGY, floating index, current era, recent epoch mints, active VPPs. |
| `/my-vpp` | `src/pages/MyVPP.tsx` | Operator's view of their VPP — wallet-gated. Balance, devices, recent mints. |
| `/devices` | `src/pages/Devices.tsx` | Network-wide device registry with filter + search. |
| `/settlement` | `src/pages/Settlement.tsx` | P2P + cross-VPP settlement form, fee preview, hashed memo. |
| `/tokenomics` | `src/pages/Tokenomics.tsx` | Halving schedule chart, cumulative energy curve, table of all eras. |

---

## Smart-contract surface consumed

Hand-written placeholder ABIs live in `src/lib/contracts.ts`. They cover only what the dashboard reads/writes:

- **XRGYToken** — `balanceOf`, `totalSupply`, `symbol`, `transfer`, `approve`, `mintingEngine`
- **MintingEngine** — `getCurrentEra`, `getCurrentRate`, `getFloatingIndex`, `totalVerifiedEnergyInStorage`, `totalEnergyEverVerified`, `currentEpoch`, `epochLength`, `tokensMintedInEra`, `epochStartTime`; events `EpochSettled`, `TokensMinted`, `Halved`
- **OracleRouter** — `registerDevice`, `setDeviceActive`, `getDevice`; events `DeviceRegistered`, `MeasurementVerified`, `DeviceActiveStatusChanged`
- **Settlement** — `settlementFeeBps`, `settle`, `settleCrossVPP`; event `Settled`

When the contracts agent finishes compilation, paste the generated ABI JSON into `src/lib/contracts.ts` verbatim. The hooks consume only the function names listed above, so a wider ABI is forward-compatible.

---

## Hooks

| Hook | Returns |
|---|---|
| `useFloatingIndex` | scaled bigint, kWh per token |
| `useEraRate` | `{ era, rate, nextHalvingAtSupply, energyForEraKwh }` |
| `useVPPDevices(vpp)` | device list reconstructed from `DeviceRegistered` + `MeasurementVerified` events |
| `useProtocolStats` | `{ totalSupply, totalVerifiedEnergyInStorage, currentEpoch, … }` (multicall) |
| `useMintEvents({ vpp?, limit? })` | recent `TokensMinted` events |

Phase 1 swaps the `getLogs`-based event hooks for a subgraph query — call-sites do not need to change.

---

## Design notes

- **Numbers as hero:** large monospace digits with tabular figures (`font-variant-numeric: tabular-nums`).
- **Dark default**, single accent (HSL `152 56% 50%` — a muted institutional mint, not crypto-lime).
- **Hairline borders, no shadows.** Shadows look "consumer SaaS"; institutional UIs use 1px borders.
- **Serif logo** (`Newsreader`) as a small intentional break from the rest of the type system — signals "this is a monetary precedent, not a JS app".
- **No chart-junk.** Recharts tooltips re-skinned to match the panel chrome; no gridlines on the X axis; log scale where it actually clarifies (mint rate over eras).

---

## What's mocked vs functional

Functional today (assuming contract addresses are wired):

- All chain reads (balances, supply, era, floating index, mint events, devices)
- Settlement writes (`settle`, `settleCrossVPP`) with fee preview and hashed memo
- Wallet connect (RainbowKit, WalletConnect v2, MetaMask via injected)

Placeholder until indexer / contract finalization:

- `cumulativeCycles` column in Devices — Proof-of-Wear is in the inner `MeasurementPacket` struct, not the current event topics. Phase 1 indexer will surface it.
- "Active VPPs" on Overview is derived from mint event uniqueness; once the contracts agent settles `VPPRegistered` events on `ProtocolGovernance.sol`, swap to that.
- Per-epoch settlement counts — currently reading the most recent N `TokensMinted`; full epoch summaries (kWh + tokens minted across all VPPs) require either indexer or a contract `getEpochSummary(epoch)` view.

---

## Phase 1 roadmap

- Subgraph integration (replace `getLogs` in `useVPPDevices` + `useMintEvents`)
- Operator-only flows: register device, deactivate device (currently only readable)
- Per-device live telemetry stream (Phase 0 surfaces only the most recent measurement)
- Charts: floating index over time, cumulative supply growth (needs historical data)
- Multi-network support (when mainnet deploys — single-file change in `src/wagmi.ts`)
