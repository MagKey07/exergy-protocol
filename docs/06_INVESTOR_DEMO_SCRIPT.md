# Investor Demo Script — 5 minutes, on Arbitrum Sepolia

**Audience:** any of the 16 Tier-1 attorneys/family offices/VPP investors in `HQ/memory/exergy-gatekeepers.md`. The demo answers ONE question: *does the protocol actually mint tokens against verified energy, live, on a public chain?*

**Outcome:** investor sees an Arbiscan transaction, the dashboard ticks up in real time, and we move from theoretical pitch to working artifact.

---

## Pre-flight (do this 30 minutes before the call)

```bash
cd /Users/magomedkiev/Desktop/Projects_Agents_Claude/Exergy/MVP

# 1. Confirm the deployment is live and addresses are populated.
cat deployments/arbitrumSepolia.json | jq .contracts

# 2. Start the dashboard (keep this terminal visible).
cd dashboard && npm run dev &
# → http://localhost:5173

# 3. Start the oracle simulator (keep this terminal visible).
cd ../oracle-simulator && npm start &

# 4. Verify simulator is producing events.
#    Watch the simulator logs — you should see one "MeasurementVerified" line
#    per TICK_SECONDS (default 30s).
```

If anything is broken, do NOT show. Reschedule. The demo only works if the chain is ticking.

---

## Demo flow (5 minutes)

### Minute 0 — Frame the demo (30 sec)

> "I want to show you the protocol running, on a public testnet, right now. Three mock VPPs in Texas, Berlin, and Sydney are producing simulated kWh measurements every 30 seconds. Each measurement is dual-signed — once by the device, once by the VPP cloud — exactly as it would be in production. The signatures are verified on-chain, and tokens mint to the VPP. This is the loop that becomes real with a hardware pilot."

### Minute 0:30 — Open the dashboard (45 sec)

```
http://localhost:5173
```

Point at:

- **Total verified energy in storage** — currently rising, in kWh
- **Total $XRGY minted** — currently rising, in tokens
- **Floating index** — currently ~1.0 in era 0 (will start to rise after first halving)
- **Current era** — 0 right now

> "Every box you see updates from the chain — there is no off-chain database. The dashboard is a read-only viewer for the smart contracts."

### Minute 1:15 — Show a fresh mint event on Arbiscan (60 sec)

Click any "Latest mints" entry on the dashboard. It opens the transaction on `sepolia.arbiscan.io`.

Highlight in the transaction:

- The `EnergyMinted` event log: deviceId, vppAddress, kwhAmount, tokensMinted, epoch, era
- The internal call: `OracleRouter.submitMeasurement` → `MintingEngine.commitVerifiedEnergy` → `XRGYToken.mint`

> "The OracleRouter rejected millions of single-signature attempts during testing — only dual-signed packets cross this boundary. That's the Anti-Simulation Lock: real value enters the system only when device hardware AND VPP cloud both attest."

### Minute 2:15 — Register a new mock VPP, live (45 sec)

In a fresh terminal:

```bash
cd /Users/magomedkiev/Desktop/Projects_Agents_Claude/Exergy/MVP

# Generate a throwaway address for the demo.
node -e "console.log(require('ethers').Wallet.createRandom().address)"
# Copy the address.

VPP_ADDRESS=0x... VPP_LABEL="Investor Demo VPP" \
  npx hardhat run --network arbitrumSepolia scripts/register-vpp.ts
```

Wait for the tx to confirm (~5 seconds on Sepolia). The dashboard's "Approved VPPs" count increments by 1.

> "We just added a new VPP to the registry on-chain. In production this is a governance action — a multi-sig with a 48-hour timelock. Today, on testnet, it's a single transaction. Watch the count tick."

### Minute 3 — Settle a P2P transfer between two demo wallets (75 sec)

```bash
# We pre-funded two demo wallets (alice, bob) during seed.
# alice has 100 XRGY; she settles 50 to bob.

npx hardhat run --network arbitrumSepolia scripts/demo-settle.ts
# (Outputs: alice → bob, gross 50 XRGY, fee 0.125 XRGY, net 49.875 to bob)
```

Open the resulting tx on Arbiscan. Highlight:

- 4 fee distribution Transfer events: Treasury (40%), Team (20%), Ecosystem (25%), Insurance (15%)
- Net transfer to bob

> "When tokens move between participants, 0.25% goes to a four-way split that funds the company treasury, team, ecosystem grants, and an insurance fund. The treasury 40% is what the equity holders get. That's how the company captures value — not from token sales, never from token sales — from protocol fees."

### Minute 4:15 — Show the floating index dynamic (45 sec)

```bash
# Trigger a redemption that consumes 50 kWh of stored energy.
npx hardhat run --network arbitrumSepolia scripts/demo-redeem.ts
```

Watch the dashboard's "Floating index" tick down a small amount and "Total verified energy in storage" drop by 50 kWh. Note that "Total $XRGY minted" does NOT decrease.

> "Energy was consumed. The token did not burn. It moved to the energy provider. The floating index dropped because the same number of tokens now back less stored energy. When the sun rises tomorrow and the battery recharges, the index will recover. Self-regulating. No artificial supply destruction. This is why we say tokens are money, not coupons."

### Minute 5 — Close (30 sec)

> "Everything you saw runs on Arbitrum Sepolia, a public testnet. The contracts are open-source. The address book is in the repo. You can run the same demo yourself in 15 minutes. The pieces still missing for production are exactly the pieces line-itemed in the Pre-Seed: a $120K audit, real HSM-signed devices, a real Chainlink adapter, and a Tier-1 VPP partner. The protocol works. The chicken-and-egg argument is dead."

Don't say more. Stop the demo. Take questions.

---

## Common questions during demo + canned answers

| Q | A |
|---|---|
| "Is this audited?" | "No. This is testnet. Audit budget — $120K with OpenZeppelin or Trail of Bits — is in the Pre-Seed line item. Mainnet does not happen until that audit closes." |
| "What stops me from minting fake tokens?" | "The OracleRouter rejects single-signature packets. You'd need to compromise both a registered device's HSM key AND the VPP cloud's signing key. Production: HSMs are physical chips on each device. MVP: simulated, but the contract code path is identical." |
| "Can the floating index go to zero?" | "Only if every battery in every connected VPP simultaneously discharges to zero. Possible in theory, never observed in practice — VPPs cycle, they don't go dark. And even at zero stored energy the supply doesn't burn — when batteries recharge, the index recovers." |
| "What happens when supply hits 1M tokens?" | "Halving event fires. Mint rate drops from 1.0 token/kWh to 0.5. We can demo this if you have time — pre-seeded a fast-halving network at `?demo=fast-halving` in the dashboard." |
| "Why Arbitrum, not Solana?" | "EVM compatibility, Ethereum security inheritance, full DeFi tooling. Solana's outage history is a non-starter for a monetary precedent. We need the chain to never be down." |
| "What's the difference vs OpenVPP?" | "OpenVPP moves fiat through energy faster — Stripe for utilities. Exergy replaces fiat in that loop entirely. Different category. See `Exergy/05_System/CORE_THESIS.md`." |

---

## Failure modes during demo

| If... | Do this |
|---|---|
| Dashboard shows zeros | Check `public/deployment.json` is current; refresh page |
| Simulator stopped producing events | Check simulator logs for nonce errors; restart |
| Sepolia RPC is slow | Switch to backup RPC: `https://arbitrum-sepolia.publicnode.com` |
| `register-vpp` reverts | Check that the deployer wallet is also the governor (or have governor sign) |
| Investor says "show me a bug" | Don't improvise. Note the question, send a follow-up after audit |

---

## Post-demo checklist

- [ ] Send investor a follow-up email with: dashboard URL, deployment.json gist, link to GitHub repo
- [ ] Log in `HQ/memory/exergy-gatekeepers.md` under their entry: demo shown, date, reaction, next step
- [ ] If LOI signal — ping Adam Exergy in the inbox, escalate to Mag
