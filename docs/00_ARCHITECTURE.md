# Exergy Protocol MVP — Architecture (single-page overview)

**Status:** Phase 0 — testnet (Arbitrum Sepolia). NOT production.
**Date:** 2026-05-08.
**Reference spec:** `../../01_Pitch/Technical_Blueprint.md`.
**Philosophy:** `../../05_System/CORE_THESIS.md` (read first).

---

## 1. What this MVP proves

A working end-to-end loop on a public testnet:

1. A registered IoT device produces a kWh measurement.
2. The device's HSM-equivalent key signs it. The VPP cloud co-signs it.
3. The dual-signed packet enters Arbitrum Sepolia via the OracleRouter.
4. MintingEngine mints `kwh_amount * mint_rate(era)` $XRGY to the VPP operator.
5. Tokens move between participants. Settlement.sol takes 0.25% fees, distributes 40/20/25/15.
6. When energy is consumed, storage drops; **tokens do NOT burn** (spec §2.4).

If an investor sees the dashboard tick up live as the oracle simulator drives kWh, the chicken-and-egg argument ("the protocol is hypothetical") loses its bite.

## 2. Component map

```
                                  ┌──────────────────────────┐
                                  │   Dashboard (React+wagmi)│
                                  │   read-only viewer        │
                                  └─────────┬────────────────┘
                                            │ JSON-RPC (Arbitrum Sepolia)
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
                                            └─────┬────────────┘
                                  transfer/permit │
                                                  ▼
                                            ┌──────────────────┐
                                            │  Settlement      │── fees ──▶ Treasury / Team /
                                            │  P2P + 0.25% fee │            Ecosystem / Insurance
                                            └─────┬────────────┘
                                                  │ admin
                                                  ▼
                                            ┌──────────────────┐
                                            │ ProtocolGovernance│
                                            │ register / pause  │
                                            └──────────────────┘
```

## 3. Data flow (single mint cycle)

```
[Battery BMS] → [Edge Pi+HSM] → [VPP Cloud] → [OracleRouter] → [MintingEngine] → [XRGYToken.mint]
   integer kWh    device-signs    VPP co-signs   verifies dual    halving math      ERC-20 transfer
                                                  signature       + epoch state     to VPP wallet
```

In MVP, the first three boxes are simulated by `oracle-simulator/`. Phase 1 swaps in real hardware once Leigh (or any pilot VPP) confirms.

## 4. Trust boundaries

| Boundary | What's trusted | What's NOT trusted |
|---|---|---|
| **Edge → Cloud** | Device HSM private key (production: ATECC608B chip) | Edge OS, network |
| **Cloud → Chain** | VPP cloud signing key + Chainlink consensus (Phase 1) | VPP cloud server compromise alone (single-sig is rejected) |
| **On-chain logic** | OZ-audited primitives, our halving math (audit pending) | Off-chain inputs without dual signature |
| **Governance** | Multi-sig governor (production); deployer (MVP) | Any single EOA in production |

The Anti-Simulation Lock (CORE_THESIS) requires BOTH device + VPP cloud signatures. Any single-sig path is rejected in `OracleRouter.submitMeasurement`.

## 5. Contract addresses

Populated by `scripts/deploy.ts` into `deployments/<network>.json`. Dashboard reads `deployments/latest.json` at build time.

| Contract | Type | Upgradeable | Address |
|---|---|---|---|
| XRGYToken | ERC-20 + ERC-2612 | NO | `<TBD on deploy>` |
| MintingEngine | UUPS proxy | YES | `<TBD>` |
| OracleRouter | UUPS proxy | YES | `<TBD>` |
| Settlement | UUPS proxy | YES | `<TBD>` |
| ProtocolGovernance | UUPS proxy | YES | `<TBD>` |

## 6. Testnet vs Production

| | Testnet (this MVP) | Production (post-audit, post-pilot) |
|---|---|---|
| Chain | Arbitrum **Sepolia** | Arbitrum One (mainnet) |
| Oracle | Mock simulator (one Node process) | Chainlink External Adapter, 3-of-5 consensus, DSO cross-validation |
| Devices | Throwaway EOAs from `seed-test-data.ts` | ATECC608B HSM per device, real BMS feed |
| Governor | Deployer EOA | Multi-sig (Safe), 48h timelock for parameter changes |
| Audit | None (multi-agent code review) | OpenZeppelin or Trail of Bits ($120K budget) |
| Real value | $0 | Live $XRGY with floor value in real energy |
| Pause / unpause | Single EOA | Multi-sig with constitution |

## 7. Dependencies between components

- `Dashboard` reads `deployments/latest.json` → resolves contract addresses + ABI.
- `Oracle Simulator` reads `deployments/latest.json` and `deployments/seed-<network>.json` → recovers device + VPP private keys, signs packets, submits to `OracleRouter`.
- `Tests` (Hardhat) deploy a fresh full system per fixture — no dependency on running services.
- `Verify script` reads `deployments/<network>.json` → calls `hardhat verify` for every contract.

## 8. What still needs to land before pilot

- [ ] Smart contracts implementations (in flight by contracts agent — interfaces already in `contracts/interfaces/`)
- [ ] Oracle simulator wired to deployed addresses
- [ ] Dashboard wired to deployed addresses
- [ ] OpenZeppelin / Trail of Bits audit (post-funding, $120K)
- [ ] Real Chainlink External Adapter
- [ ] Real DSO cross-validation feed
- [ ] HSM-backed device signing (ATECC608B integration)
- [ ] Multi-sig governor
- [ ] Sepolia → Arbitrum One migration
