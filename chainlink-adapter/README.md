# Exergy Chainlink External Adapter

Reference implementation of the Chainlink External Adapter layer between a VPP
Cloud and the on-chain `OracleRouter`.

> **Concept note (CORE_THESIS):** this is ONE implementation among many.
> Anyone can run their own adapter — like SMTP, Gmail and Outlook are both
> valid email clients. The on-chain protocol verifies dual signatures and
> a single `CHAINLINK_RELAYER_ROLE` binding; everything else (DSO query,
> 3-of-5 node consensus, transport) is off-chain and replaceable. Open-source
> from day one. MIT-licensed.

---

## Architecture

```
[VPP Cloud (mock or real)]
    │ HTTPS POST /submit { packet, deviceSignature, vppSignature }
    ▼
[Chainlink External Adapter]   ← this repo
    │  1. Parse JSON
    │  2. verifier.ts:    off-chain ECDSA recovery (defence-in-depth)
    │  3. consensus.ts:   3-of-5 simulated nodes, each runs dso-mock
    │  4. dso-mock.ts:    ±5% noise, ≤ 20% discrepancy threshold per node
    │  5. relayer.ts:     OracleRouter.submitMeasurement(...) via CHAINLINK_RELAYER_ROLE
    ▼
[OracleRouter]   ← contracts/OracleRouter.sol
    │  verifies dual signatures AGAIN on-chain (defence-in-depth)
    │  enforces device registry binding
    │  forwards to MintingEngine
    ▼
[MintingEngine] (no changes)
```

**Why this layering matters:**

- The adapter is the operational gatekeeper. It can be DOSed, replaced, or
  audited — but it cannot mint without a valid dual signature, because the
  contract repeats the verification. This is the on-thesis answer to "no
  centralized software gatekeeping".
- Constants (`3-of-5`, `20% DSO threshold`) are hard-coded in `src/types.ts`.
  They are NOT exposed as runtime config — by design. Tunable parameters are
  the path to "centralized human review", which CORE_THESIS §5.5 forbids.

---

## Install + run (local, against the existing localhost MVP)

```bash
# 0. Background — Hardhat node should be running on :8545 with contracts
#    deployed. See MVP/scripts/deploy.ts and MVP/PROGRESS.md.

cd chainlink-adapter
npm install              # installs ethers, express, winston, commander, ts-node, ...
cp .env.example .env     # then fill RELAYER_PRIVATE_KEY + ORACLE_ROUTER_ADDRESS

# Health check (no server) — verifies role binding visible from the chain.
npm run dev -- health

# Start the HTTP adapter (long-running).
npm run dev              # → "adapter listening" on http://127.0.0.1:9000
```

`RELAYER_PRIVATE_KEY` must hold `CHAINLINK_RELAYER_ROLE` on `OracleRouter`.
The default deploy script grants the bootstrap relayer to the deployer
address — set `RELAYER_PRIVATE_KEY` to that key for testnet/localhost. See
`MAINNET_HARDENING.md` for the production migration.

---

## End-to-end demo (oracle-simulator → adapter → contract)

```bash
# Terminal 1 — Hardhat node
cd MVP
npx hardhat node                                                   # localhost:8545

# Terminal 2 — deploy + register devices
npx hardhat run --network localhost scripts/deploy.ts
npx hardhat run --network localhost scripts/seed-test-data.ts

# Terminal 3 — adapter
cd MVP/chainlink-adapter
npm run dev

# Terminal 4 — simulator (default mode is via-adapter)
cd MVP/oracle-simulator
npx ts-node scripts/demo-vpp-fleet.ts
```

The simulator now POSTs each dual-signed packet to the adapter; the adapter
verifies + runs consensus + relays on-chain. Watch `tx-confirmed` events in
the adapter log and `Mint` events in the dashboard.

---

## HTTP API

### `POST /submit`

Request body (JSON):

```json
{
  "packet": {
    "deviceId": "0x1234...32 bytes",
    "kwhAmount": "5000000000000000000",
    "timestamp": "1700000000",
    "storageCapacity": "13500000000000000000",
    "chargeLevelPercent": 65,
    "sourceType": 0,
    "cumulativeCycles": 12
  },
  "deviceSignature": "0x... 65 bytes ...",
  "vppSignature":    "0x... 65 bytes ...",
  "requestId": "optional-correlation-id"
}
```

bigints (`kwhAmount`, `timestamp`, `storageCapacity`) are **decimal strings** —
JSON has no native bigint. The adapter parses them with `BigInt(...)` and
re-encodes as `uint256`/`uint64` for the contract call.

Responses:

| Status | Stage       | Meaning                                             |
|-------:|-------------|-----------------------------------------------------|
| 200    | -           | Accepted + relayed. Body has `txHash`, `blockNumber` |
| 400    | -           | Malformed JSON / missing field                       |
| 422    | `verify`    | Off-chain dual-sig recovery failed                   |
| 422    | `consensus` | <3 of 5 nodes accepted (DSO discrepancy too high)    |
| 502    | `relay`     | RPC error / contract revert during submission        |

### `GET /health`

Returns relayer address, role-binding status (yes/no/unknown), router address,
chain id, dialect tag. Used by ops dashboards and the simulator's pre-flight.

### `GET /version`

Static metadata: dialect tag (`EXERGY_CHAINLINK_ADAPTER_V1`), consensus
parameters, DSO threshold. No mutable state.

---

## Writing your own adapter

The protocol is open. To run an alternative adapter:

1. Hold `CHAINLINK_RELAYER_ROLE` on `OracleRouter` (granted by governance).
2. Verify the dual signature off-chain (any language; reference recovery
   scheme in `verifier.ts` and in `MVP/docs/PROTOCOL_SPEC.md` §3-4).
3. Run your own DSO cross-reference (real grid data, your nodes, your trust
   model — but the contract still repeats sig verification on-chain, so a
   compromised adapter can only DOS, not mint).
4. Submit the dual-signed packet via
   `OracleRouter.submitMeasurement(packet, deviceSig, vppSig)`.

Multiple adapters can hold the role simultaneously — the protocol does not
require exclusivity. A VPP that doesn't trust this implementation can run
its own.

---

## Tests

```bash
npm test
```

Runs:
- `verifier.test.ts` — dual-signature recovery + dialect parity with the
  contract (regression guard for CONCEPT_AUDIT D-1).
- `dso-mock.test.ts` — DSO threshold semantics (5% noise always passes, >20%
  always fails, exact boundary is 2000 bps).
- `consensus.test.ts` — 3-of-5 threshold, no admin override path.

E2E HTTP-level tests are deferred to Phase 1 (`curl` smoke tests will run
manually for the MVP demo).

---

## Concept guardrails (DO NOT REMOVE)

These are encoded in code but documented here so reviewers can spot drift:

1. **No admin overrides.** No "approve this packet anyway" flag. No allow-list
   for trusted VPPs that skip DSO. The pipeline is deterministic.
2. **No mutable thresholds.** `CONSENSUS_NODE_COUNT`, `CONSENSUS_THRESHOLD`,
   `DSO_DISCREPANCY_THRESHOLD_BPS` are `const` exports — mutating them at
   runtime requires re-deploying the adapter.
3. **Defence-in-depth, not gatekeeping.** The contract verifies signatures
   regardless of which relayer called it. The adapter's verifier is a
   fail-fast off-chain mirror.
4. **Open ecosystem.** Multiple adapters can hold the role. The contract
   doesn't care which adapter relayed a valid packet.

If any of these are violated in code, file an issue tagged `concept-drift`.

---

## License

MIT — see `MVP/LICENSE` at the repo root.
