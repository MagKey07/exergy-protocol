# Exergy Protocol

**The first money backed by verified physical energy storage.**

A working testnet implementation of a sectoral monetary system: tokens are minted only against kWh that are demonstrably stored in real, signed, IoT-attested batteries operated by Virtual Power Plants. No pre-mine. No token sale. No peg. The right to mint is earned by physical energy storage — Proof-of-Charge.

---

## The thesis

**Universal money is a bug of civilization.** One currency for bread, oil, labor, gold, and computation warps value away from merit toward mass. The fix is not another reform of fiat — it is replacement: each economic sector should have its own monetary unit, backed by the fundamental asset of that sector. Exergy is the first working example. If it holds, the model spreads to water, compute, grain, and beyond. The full argument lives in the SSRN paper (#6500878) and in [`05_System/CORE_THESIS.md`](../05_System/CORE_THESIS.md).

**Tokens come from energy, not from issuance.** $XRGY genesis supply is zero. The only path to new tokens is `MintingEngine.commitVerifiedEnergy`, which itself is gated to the OracleRouter, which itself rejects any measurement packet that lacks both a device-level ECDSA signature and a VPP-cloud co-signature (the Anti-Simulation Lock). Every minted token corresponds to a real kWh sitting in a real battery, attested to by a tamper-resistant chain of cryptographic signatures. The minting rate halves every 1,000,000 tokens, so each successive token is denser in stored energy than its predecessors. Halving is driven by physics, not by adoption.

**The protocol is the engine, not the company.** Investors buy equity in Key Energy, Inc. (Delaware C-Corp) via standard SAFE — they do not buy tokens, and the company does not sell tokens to anyone, ever. Treasury accrues only via a 40% share of protocol fees, paid in already-circulating $XRGY. The smart contracts run on Arbitrum One (Ethereum L2 security) and continue to mint, halve, and settle even if the company dissolves; equity is enforced through Delaware corporate law, not through a wallet. This is by deliberate design.

---

## What is in this repo

Phase 0 (testnet foundation) artifacts. All implementation is open-source under MIT.

| Component | Files | Lines | Purpose |
|---|---|---|---|
| `contracts/` | 5 contracts + 5 interfaces | ~1,612 | Solidity 0.8.24 + OpenZeppelin 5.0.2. XRGYToken (immutable ERC-20 + permit), MintingEngine (halving + epoch + floating index), OracleRouter (dual-signature trust boundary), Settlement (P2P + cross-VPP transfers, 0.25% fee), ProtocolGovernance (registry + admin) |
| `oracle-simulator/` | 10 TS files | ~1,546 | Node.js + ethers v6. Mocks the BMS → edge → VPP-cloud signing chain end-to-end. Generates dual-signed measurement packets and submits them to the deployed router. Replaces real hardware until Phase 1. |
| `dashboard/` | React app | ~2,954 | Vite + TypeScript strict + wagmi v2 + RainbowKit + Recharts. Live read-only viewer over JSON-RPC: total verified energy, total tokens minted, current era, floating index, per-VPP minting, settlement explorer. |
| `test/` | 8 Hardhat suites | ~1,662 | Token, MintingEngine, OracleRouter, Settlement, Governance unit tests + EndToEnd integration. Tests are written against the spec, not the implementation, so red tests are signal not noise. |
| `scripts/` | 5 deployment scripts | ~492 | Deploy, verify, seed mock VPPs and devices, demo helpers. |
| `docs/` | 9 design + audit docs | — | Architecture, security, deployment, investor demo, build logs, and the [concept-fidelity audit](docs/CONCEPT_AUDIT.md). |

---

## Status

**Phase 0 — testnet MVP. Built May 2026 by an autonomous AI agent team as proof-of-implementation for the Pre-Seed round.**

- Deployed on Arbitrum Sepolia (testnet) and a local Hardhat node. **Not on mainnet.**
- **Not security-audited.** A professional audit (OpenZeppelin or Trail of Bits, $120K, line-itemed in the Pre-Seed budget) is mandatory before mainnet. Multi-agent code review on testnet is a substitute, not a replacement.
- **No real value at risk.** No mainnet $XRGY exists. The token only acquires energy backing once a real VPP feeds real measurements through real HSM-attested devices in Phase 1.
- The `MAINNET_HARDENING.md` checklist in [`docs/MAINNET_HARDENING.md`](docs/MAINNET_HARDENING.md) lists every admin role to revoke, every test hook to strip, and every governance gate to wire before any deployment that touches real money.

---

## Run the demo locally

Prerequisites: Node.js 20.x, npm 10.x.

```bash
# 1. Install three workspaces
npm install
cd oracle-simulator && npm install && cd ..
cd dashboard && npm install && cd ..

# 2. Compile contracts and run the test suite
npx hardhat compile
npx hardhat test

# 3. Start a local Hardhat node (separate terminal, keep running)
npx hardhat node

# 4. Deploy all five contracts to the local node
npx hardhat run --network localhost scripts/deploy.ts

# 5. Seed three mock VPPs (Texas / Berlin / Sydney) with five devices each
npx hardhat run --network localhost scripts/seed-test-data.ts

# 6. Start the oracle simulator (separate terminal)
cd oracle-simulator
cp .env.example .env       # set RPC_URL=http://127.0.0.1:8545, ADDRESS_BOOK=../deployments/localhost.json
npm start

# 7. Start the dashboard (separate terminal)
cd dashboard
cp ../deployments/localhost.json public/deployment.json
npm run dev                # opens http://localhost:5173
```

Within a minute the dashboard "Total verified energy" and "Total tokens minted" tickers should advance every 30 seconds as the simulator drives signed kWh through the OracleRouter and into the MintingEngine. The floating index sits near 1.0 in Era 0 and steps up at every 1,000,000-token halving boundary. To deploy on Arbitrum Sepolia instead of localhost, follow [`docs/04_DEPLOYMENT.md`](docs/04_DEPLOYMENT.md) — the only difference is funding the deployer wallet and pointing `--network` at `arbitrumSepolia`.

---

## Architecture

```
                                  ┌──────────────────────────┐
                                  │   Dashboard (React+wagmi)│
                                  │   read-only viewer       │
                                  └─────────┬────────────────┘
                                            │ JSON-RPC (Arbitrum / localhost)
                                            ▼
   ┌──────────────────┐     dual-signed     ┌──────────────────┐
   │ Oracle Simulator │ ──────────────────▶│  OracleRouter    │
   │ (Node.js)        │     packets        │  trust boundary  │
   └──────────────────┘                    └─────────┬────────┘
   mock device + cloud                               │ commitVerifiedEnergy()
   signers (testnet only)                            ▼
                                            ┌──────────────────┐
                                            │  MintingEngine   │ ◀── recordEnergyConsumption()
                                            │  halving + index │       (called by Settlement)
                                            └─────┬────────────┘
                                          mint()  │
                                                  ▼
                                            ┌──────────────────┐
                                            │  XRGYToken       │
                                            │  ERC-20 + permit │
                                            │  (IMMUTABLE)     │
                                            └─────┬────────────┘
                                  transfer/permit │
                                                  ▼
                                            ┌──────────────────┐
                                            │  Settlement      │── fees ──▶ Treasury 40% / Team 20% /
                                            │  P2P + 0.25% fee │            Ecosystem 25% / Insurance 15%
                                            └─────┬────────────┘
                                                  │ admin (testnet only)
                                                  ▼
                                            ┌──────────────────┐
                                            │ ProtocolGovernance│
                                            │ register / pause  │
                                            └──────────────────┘
```

Single mint cycle:

```
[Battery BMS] → [Edge Pi+HSM] → [VPP Cloud] → [OracleRouter] → [MintingEngine] → [XRGYToken.mint]
   integer kWh    device-signs    VPP co-signs   verifies dual    halving math      ERC-20 transfer
                                                  signatures      + epoch state     to VPP wallet
```

In Phase 0 the first three boxes are simulated. Phase 1 replaces them with real BMS feeds, ATECC608B-signed packets, and Chainlink External Adapter consensus.

---

## Reading order for the codebase

1. [`05_System/CORE_THESIS.md`](../05_System/CORE_THESIS.md) — what Exergy actually is. Read first.
2. [`01_Pitch/Technical_Blueprint.md`](../01_Pitch/Technical_Blueprint.md) — the formal technical specification.
3. [`docs/00_ARCHITECTURE.md`](docs/00_ARCHITECTURE.md) — single-page system overview.
4. `contracts/XRGYToken.sol` — the smallest contract; sets the immutability constraints.
5. `contracts/MintingEngine.sol` — halving math, epoch sealing, floating index.
6. `contracts/OracleRouter.sol` — the trust boundary; dual-signature verification.
7. `contracts/Settlement.sol` — fee math and the no-burn invariant.
8. `oracle-simulator/src/index.ts` — drives the demo end-to-end.
9. `test/integration/EndToEnd.t.ts` — what a passing protocol cycle looks like.

---

## Key documents

- [`docs/CONCEPT_AUDIT.md`](docs/CONCEPT_AUDIT.md) — line-by-line audit of the Phase 0 implementation against the monetary thesis. 9 of 13 invariants aligned, 4 drift cases catalogued (admin surface), zero outright violations.
- `docs/PROTOCOL_SPEC.md` — canonical dual-signature dialect for third-party VPP-cloud signers (forthcoming, separate sprint deliverable). Lets a Gmail/Outlook-style ecosystem of independent connectors emerge against one open protocol.
- [`docs/06_INVESTOR_DEMO_SCRIPT.md`](docs/06_INVESTOR_DEMO_SCRIPT.md) — 10-minute live demo walkthrough.
- [`docs/04_DEPLOYMENT.md`](docs/04_DEPLOYMENT.md) — Arbitrum Sepolia deploy guide.
- [`docs/MAINNET_HARDENING.md`](docs/MAINNET_HARDENING.md) — pre-mainnet checklist (admin removal, audit, multi-sig, timelock).

---

## Security

This is a testnet protocol. Audit is pending. Real economic value will not flow through these contracts until every item in [`docs/05_SECURITY.md`](docs/05_SECURITY.md) and [`docs/MAINNET_HARDENING.md`](docs/MAINNET_HARDENING.md) is closed. In particular:

- UUPS upgrade authority is held by the deployer EOA (testnet only — must move to a 48h timelock + multi-sig before mainnet).
- A `TEST_HOOK_ROLE` exists on `MintingEngine` to allow QA epoch overrides — this role MUST be revoked from every address and the underlying functions stripped or chain-id-gated before mainnet.
- Pause functions exist on every module — they must be replaced by the autonomous circuit-breaker described in Technical_Blueprint §3 before mainnet.

To report a vulnerability: email `info@keyenergy.io` with subject "Security:". A bug bounty program (Immunefi, $25-50K initial pool) will go live alongside the audited Phase 1 deployment.

---

## License

MIT. See [`LICENSE`](LICENSE).

Open-source from day one is a deliberate design constraint, not a marketing posture: the protocol explicitly refuses centralized software gatekeeping (CORE_THESIS §5.5). Multiple independent implementations of the VPP-cloud signer and the dashboard are encouraged — like SMTP, the protocol is the contract, not the client.

---

## Background reading

- **SSRN paper #6500878** — Economic Theory of Relativity (ETR), the formal monetary argument behind sectoral currencies. <https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6500878>
- **Cambridge Journal of Economics, submission CJE-2026-194** — peer-reviewed companion paper, currently in administrative processing.
- Book in progress: *A Loading Dose of Sense* (Magomed Kiev) — the long-form articulation of the monetary thesis.

---

## Contact

Key Energy, Inc. (Delaware C-Corp) — `info@keyenergy.io`.
