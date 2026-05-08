# Deployment Guide — Exergy Protocol MVP

**Target chain:** Arbitrum Sepolia (chainId 421614).
**Status:** testnet only. No real value at risk.

---

## 0. Prerequisites

- Node.js 20.x
- npm 10.x (or pnpm)
- A funded Sepolia wallet (Arbitrum Sepolia ETH from <https://faucet.quicknode.com/arbitrum/sepolia>)
- An Arbiscan API key (for verification): <https://arbiscan.io/myapikey>
- Optional: Tenderly account for tx debugging

## 1. Clone and install

```bash
cd /Users/magomedkiev/Desktop/Projects_Agents_Claude/Exergy/MVP

# Top-level: contracts + scripts + tests
npm install

# Oracle simulator (separate workspace)
cd oracle-simulator && npm install && cd ..

# Dashboard (separate workspace)
cd dashboard && npm install && cd ..
```

## 2. Environment

Copy `.env.example` → `.env` at the MVP root and fill in:

```bash
DEPLOYER_PRIVATE_KEY=0x...                 # funded Sepolia EOA
ARBITRUM_SEPOLIA_RPC=https://sepolia-rollup.arbitrum.io/rpc
ARBISCAN_API_KEY=...

# Optional — set per-actor addresses for fee receivers.
# Defaults: all fall back to the deployer.
GOVERNOR_ADDRESS=0x...
TREASURY_ADDRESS=0x...
TEAM_ADDRESS=0x...
ECOSYSTEM_ADDRESS=0x...
INSURANCE_ADDRESS=0x...
```

## 3. Compile + test

```bash
npx hardhat compile

# Run the full test suite. Once contracts land, expect ~80 tests, ~30s.
npx hardhat test

# Coverage report
npx hardhat coverage
```

## 4. Deploy to Arbitrum Sepolia

```bash
npx hardhat run --network arbitrumSepolia scripts/deploy.ts
```

Expected output: a table of five addresses + a JSON file at `deployments/arbitrumSepolia.json`. The script also writes `deployments/latest.json` so the dashboard config remains stable across redeploys.

## 5. Verify on Arbiscan

```bash
npx hardhat run --network arbitrumSepolia scripts/verify.ts
```

This iterates the address book and runs `hardhat verify` for the token + each UUPS implementation. "Already verified" is fine.

## 6. Seed mock VPPs + devices for the demo

```bash
npx hardhat run --network arbitrumSepolia scripts/seed-test-data.ts
```

Output: `deployments/seed-arbitrumSepolia.json` containing:

- 3 mock VPPs (Texas / Berlin / Sydney)
- 5 mock devices per VPP (with throwaway private keys)

Hand this file off to the oracle simulator (next step).

## 7. Wire the dashboard

```bash
cd dashboard
# Copy address book in.
cp ../deployments/latest.json public/deployment.json

npm run dev   # local dev server, http://localhost:5173
# OR
npm run build && npm run preview
```

Dashboard reads `public/deployment.json` at runtime, so a redeploy + recopy = fresh data without rebuilding.

## 8. Start the oracle simulator

```bash
cd oracle-simulator

# Configure
cp .env.example .env
# Edit .env:
#   RPC_URL=https://sepolia-rollup.arbitrum.io/rpc
#   ADDRESS_BOOK=../deployments/latest.json
#   SEED_FILE=../deployments/seed-arbitrumSepolia.json
#   TICK_SECONDS=30        # how often a mock device produces a measurement
#   KWH_PER_TICK=10        # mock energy per tick

npm start
```

The simulator picks a random device every TICK_SECONDS, generates a measurement, signs it as the device + VPP cloud, and calls `OracleRouter.submitMeasurement`.

You should see `EnergyMinted` events in the Sepolia explorer and the dashboard should tick up.

## 9. End-to-end demo flow

After all six previous steps:

```bash
# Open dashboard:
open http://localhost:5173

# Watch:
#   - "Total verified energy in storage"  ↑ every 30s
#   - "Total tokens minted"               ↑ every 30s
#   - "Floating index"                    flat at ~1.0 in era 0
#   - "Current era"                       0 → 1 once 1M tokens accumulate

# Trigger a P2P settlement (any wallet with $XRGY):
npx hardhat run --network arbitrumSepolia scripts/demo-settle.ts
# (TODO: include this convenience script in next iteration)
```

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `insufficient funds for gas` on deploy | Sepolia wallet not funded | Get more from QuickNode faucet |
| `verify` says "Etherscan rejected" | API key missing / rate-limited | Set `ARBISCAN_API_KEY`, retry |
| `MintingEngineAlreadySet` on second deploy | Old token contract still wired | Deploy is non-idempotent — start fresh by deploying a new XRGYToken |
| Oracle simulator exits with `nonce too low` | Multiple processes racing the same wallet | Run only one simulator process per VPP cloud key |
| Dashboard shows zeros | `public/deployment.json` not refreshed | Re-copy `deployments/latest.json` after redeploy |

## 11. Going to mainnet — DO NOT (yet)

This MVP must not be deployed to Arbitrum One until:

1. OpenZeppelin or Trail of Bits audit passes ($120K, post-funding).
2. Halving math is formally verified (see `05_SECURITY.md`).
3. Governor is migrated to a multi-sig with 48h timelock.
4. HSM-backed device signing replaces the simulator.
5. Real Chainlink External Adapter + DSO cross-validation are live.

See `05_SECURITY.md` for the full pre-mainnet checklist.
