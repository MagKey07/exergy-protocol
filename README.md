# Exergy Protocol — MVP (Phase 0: Foundation)

**Status:** Pre-implementation. Directory scaffolded 2026-05-08.

## What This Is

Phase 0 deliverables per `Exergy/01_Pitch/Technical_Blueprint.md`:
- ✅ Smart contracts (5): XRGYToken, MintingEngine, OracleRouter, Settlement, ProtocolGovernance
- ✅ Oracle simulator (mock VPP — no real hardware yet)
- ✅ Dashboard prototype (Web3 frontend for VPP operators)
- ✅ Hardhat testing framework
- ✅ Deployment scripts (Arbitrum Sepolia testnet)

## What This Is NOT

- NOT production deployment — testnet only, no mainnet, no real value at risk
- NOT security audited — production needs OpenZeppelin / Trail of Bits ($30-50k, post-funding)
- NOT real VPP integration — mock telemetry; real Leigh integration = Phase 1

## Why MVP

Demonstrate working protocol on testnet → break investor chicken-and-egg cycle → leverage for Pre-Seed close at higher valuation.

## Reference Docs

- `../01_Pitch/Technical_Blueprint.md` — full technical spec
- `../05_System/CORE_THESIS.md` — what Exergy is (read first)
- `../Data Room/Technical_Documentation/Exergy_Technical_Blueprint.pdf` — investor version

## Stack

- **Chain:** Arbitrum One (Sepolia testnet for MVP)
- **Smart contracts:** Solidity 0.8.24, OpenZeppelin
- **Dev framework:** Hardhat + ethers.js
- **Frontend:** React + Vite + TypeScript + wagmi/viem
- **Oracle simulator:** Node.js + ECDSA signing
- **Testing:** Hardhat + Foundry (gas optimization)

## Folder Structure

```
MVP/
├── contracts/          # Solidity smart contracts
├── test/              # Hardhat + Foundry tests
├── scripts/           # Deploy scripts
├── oracle-simulator/  # Mock VPP data generator
├── dashboard/         # React Web3 frontend
└── docs/              # Architecture decision records, build logs
```

