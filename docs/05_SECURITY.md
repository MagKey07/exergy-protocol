# Security Notes — Exergy Protocol MVP

**This document is honest, not promotional.** This MVP is a testnet demonstration. It is NOT production. It is NOT audited. Real value would be at risk in production. Do not point a mainnet deployment at these contracts.

If you are an investor reading this and thinking "that's a problem" — it is not. This is the same posture every responsible team takes between Phase 0 (foundation) and Phase 1 (audited pilot). The audit budget ($120K, OpenZeppelin or Trail of Bits) is line-itemed in the Pre-Seed.

---

## 1. Threat model — what we defend against

### In scope (defended on testnet)

| Threat | Defense |
|---|---|
| **Single-sig spoofed measurement** | OracleRouter rejects packets without both device + VPP cloud signatures (Anti-Simulation Lock) |
| **Replayed measurement** | Per-packet hash uniqueness; `isMeasurementProcessed(hash) == true` blocks re-submission |
| **Unauthorized mint** | XRGYToken.mint reverts unless caller == bound MintingEngine |
| **Double-wiring of MintingEngine** | One-shot setter; `MintingEngineAlreadySet` after first call |
| **Halving misfire** | Era + rate read on every mint; HalvingTriggered event when boundary crosses |
| **Settlement fee leak** | Fee distribution constants tested for sum = fee (≤ 3 wei rounding tolerance) |
| **Sneak burn** | NO burn function exists. Total supply only goes up. Tested in XRGYToken.t.ts and EndToEnd.t.ts |
| **Pause race** | `pause()` restricted to governor; tests assert non-owner reverts |

### Out of scope for testnet (must be addressed before mainnet)

| Threat | Status |
|---|---|
| Compromised VPP cloud signing key | Production: HSM at the cloud, key rotation procedure. MVP: throwaway EOA. |
| Compromised device HSM | Production: ATECC608B in tamper-evident enclosure. MVP: in-memory wallet. |
| Chainlink node collusion | Production: 3-of-5 consensus + DSO cross-check. MVP: single mock oracle. |
| Governor key compromise | Production: multi-sig (Safe) + 48h timelock. MVP: deployer EOA. |
| Re-entrancy on Settlement | OZ ReentrancyGuard expected on Settlement; **must be confirmed in audit** |
| Gas griefing on Oracle | Per-call gas limit + signature pre-check expected; **must be confirmed in audit** |
| MEV on first listing | Liquidity bootstrapping plan for DEX listing — not part of MVP |

## 2. Why testnet only — the explicit list

1. **Halving math is unaudited.** A bug here mints wrong-amount tokens permanently. We need formal verification (Certora or equivalent) of the boundary-crossing math before any real value flows.
2. **Signature recovery code path is unaudited.** ECDSA edge cases (malleability, EIP-155, raw vs. EIP-191 prefixed signatures) are notoriously easy to get wrong.
3. **Upgrade authorization is permissive.** UUPS proxies on MVP can be upgraded by the governor EOA. In production this becomes a multi-sig + 48h timelock.
4. **The fee distribution math has 3-wei rounding tolerance** — that's fine on testnet but must be reviewed for value-leak vectors at mainnet scale.
5. **The reentrancy posture is assumed but not proven.** Settlement reads/writes balance, calls MintingEngine, transfers tokens — multiple state changes per call. Audit must confirm the ordering is safe under reentrancy.
6. **No DSO cross-validation.** Production rejects epochs where the IoT-reported kWh disagrees with grid operator data by >20%. MVP trusts the simulator.
7. **No anomalous-cycling rejection.** Production rejects measurement packets where `cumulative_cycles` is inconsistent with storage capacity (Proof-of-Wear flag). MVP accepts whatever the simulator produces.

## 3. How we substitute audit on testnet

Multi-agent code review is the substitute (NOT replacement) for a paid audit:

1. The contracts agent writes the implementations against the interface stubs.
2. This QA/DevOps agent writes tests against the spec, not against the implementation. Tests fail until the implementation matches the SPEC, not the other way around.
3. A separate code-review agent run audits the contracts after they land.
4. A red-team prompt runs adversarial scenarios against the system.
5. Mag (the user) reviews the final state.

This is appropriate for testnet. It is NOT appropriate for mainnet. We say this explicitly.

## 4. Pre-mainnet checklist

Cannot deploy to Arbitrum One until ALL of the following are done:

- [ ] Professional audit by OpenZeppelin or Trail of Bits, with all High/Critical findings resolved
- [ ] Formal verification of halving math (Certora spec for boundary crossing)
- [ ] Settlement reentrancy proven safe (audit + ReentrancyGuard)
- [ ] HSM-backed device signing with key rotation procedure
- [ ] Real Chainlink External Adapter with 3-of-5 node consensus
- [ ] DSO cross-validation feed (per VPP region)
- [ ] Multi-sig governor (Safe with at least 3-of-5 key holders)
- [ ] 48h timelock on parameter changes (per spec §10.3)
- [ ] Liquidity bootstrapping plan reviewed by legal (utility token, not security)
- [ ] MiCA + US regulatory review complete (per spec §8 risk row "Regulation")
- [ ] Bug bounty program live (Immunefi or equivalent), at least $50K cap
- [ ] Public test campaign (incentivized testnet, ≥30 days, no critical findings)
- [ ] Investor LOI from at least one Tier-1 VPP for real-fleet pilot

## 5. What an attacker can do on the MVP testnet

Honest assessment, in case anyone tries:

- An attacker who controls a registered device's private key can submit duplicate-but-distinct packets at will (different timestamps). They mint tokens against fake measurements → those tokens have **no economic value on testnet**. Cost to defenders: zero.
- An attacker who compromises the deployer EOA can pause the protocol, register fake VPPs, register fake devices. Same answer: testnet, no value.
- An attacker cannot bypass the dual-signature requirement. They cannot mint without a registered device key + the correct VPP cloud key for that device. The Anti-Simulation Lock holds.
- An attacker cannot burn tokens (no burn function exists).

## 6. What an attacker could do on a hypothetical un-audited mainnet (DO NOT DEPLOY)

- Exploit unknown halving-math edge case to over-mint
- Exploit unknown ECDSA recovery edge case to forge signatures
- Re-enter Settlement during fee distribution, double-spend allowance
- Front-run upgrade transactions
- Compromise governor EOA, drain fee receivers

This is why we don't.

---

*Last updated: 2026-05-08. Owner: QA/DevOps agent. Adjacent: `00_ARCHITECTURE.md`, `04_DEPLOYMENT.md`.*
