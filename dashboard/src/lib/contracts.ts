/**
 * Hand-written placeholder ABIs covering everything the dashboard reads/writes.
 *
 * These are derived from MVP/contracts/interfaces/*.sol and
 * Technical_Blueprint.md §2. Once the contracts agent compiles the actual
 * Solidity, the ABI JSON in `out/<Contract>.sol/<Contract>.json` should be
 * dropped in here verbatim — the dashboard hooks consume only the function
 * names listed below, so a wider ABI is forward-compatible.
 *
 * IMPORTANT: this is intentionally a *narrow* surface — only fns the dashboard
 * actually calls. Do not add unused entries.
 */

import type { Abi } from "viem";

// ─────────────────────────────────────────────────────────────────────────────
// XRGYToken — ERC-20 + EIP-2612 + minimal Exergy extensions
// ─────────────────────────────────────────────────────────────────────────────
export const xrgyTokenAbi = [
  // ERC-20
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "mintingEngine",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  // Events
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const satisfies Abi;

// ─────────────────────────────────────────────────────────────────────────────
// MintingEngine — minting, halving, floating index
// ─────────────────────────────────────────────────────────────────────────────
export const mintingEngineAbi = [
  {
    type: "function",
    name: "currentEra",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "currentMintRateWeiPerKwh",
    stateMutability: "view",
    // Rate scaled 1e18 (1.0 token/kWh in Era 0 = 1e18)
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getFloatingIndex",
    stateMutability: "view",
    // = totalVerifiedEnergyInStorage * 1e18 / totalSupply  (kWh per token, 1e18-scaled)
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalVerifiedEnergyInStorage",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "currentEpoch",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  // Events — keep aligned with MVP/contracts/interfaces/IMintingEngine.sol
  {
    type: "event",
    name: "EnergyMinted",
    inputs: [
      { name: "deviceId", type: "bytes32", indexed: true },
      { name: "vppAddress", type: "address", indexed: true },
      { name: "kwhAmount", type: "uint256", indexed: false },
      { name: "tokensMinted", type: "uint256", indexed: false },
      { name: "epoch", type: "uint256", indexed: true },
      { name: "era", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "HalvingTriggered",
    inputs: [
      { name: "newEra", type: "uint256", indexed: true },
      { name: "newRateNumerator", type: "uint256", indexed: false },
      { name: "totalSupplyAtHalving", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "EpochSealed",
    inputs: [{ name: "epoch", type: "uint256", indexed: true }],
  },
] as const satisfies Abi;

/**
 * `EPOCH_DURATION` is a `uint256 public constant = 1 days` on the contract,
 * not a callable view function. Surface it as a known constant so the UI
 * does not need an RPC roundtrip for what never changes.
 */
export const EPOCH_DURATION_SECONDS = 86_400n;

// ─────────────────────────────────────────────────────────────────────────────
// OracleRouter — device registry, measurement submission
// ─────────────────────────────────────────────────────────────────────────────
export const oracleRouterAbi = [
  {
    type: "function",
    name: "registerDevice",
    stateMutability: "nonpayable",
    inputs: [
      { name: "deviceId", type: "bytes32" },
      { name: "vppAddress", type: "address" },
      { name: "devicePubKeyHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setDeviceActive",
    stateMutability: "nonpayable",
    inputs: [
      { name: "deviceId", type: "bytes32" },
      { name: "active", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getDevice",
    stateMutability: "view",
    inputs: [{ name: "deviceId", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "vppAddress", type: "address" },
          { name: "devicePubKeyHash", type: "bytes32" },
          { name: "active", type: "bool" },
        ],
      },
    ],
  },
  // Events used to reconstruct VPP device lists client-side via getLogs.
  {
    type: "event",
    name: "DeviceRegistered",
    inputs: [
      { name: "deviceId", type: "bytes32", indexed: true },
      { name: "vppAddress", type: "address", indexed: true },
      { name: "devicePubKeyHash", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "DeviceActiveStatusChanged",
    inputs: [
      { name: "deviceId", type: "bytes32", indexed: true },
      { name: "active", type: "bool", indexed: false },
    ],
  },
  {
    type: "event",
    name: "MeasurementVerified",
    inputs: [
      { name: "deviceId", type: "bytes32", indexed: true },
      { name: "vppAddress", type: "address", indexed: true },
      { name: "kwhAmount", type: "uint256", indexed: false },
      { name: "timestamp", type: "uint64", indexed: false },
      { name: "epoch", type: "uint256", indexed: false },
    ],
  },
] as const satisfies Abi;

// ─────────────────────────────────────────────────────────────────────────────
// Settlement — intra-VPP + cross-VPP transfers with protocol fee
//
// Mirrors contracts/Settlement.sol verbatim. Fee semantics: the settlement
// fee (`settlementFeeBps`, default 25 = 0.25%) is paid ON TOP of the principal
// by the payer. The recipient receives the full `tokenAmount`. The payer must
// approve `tokenAmount + fee` to Settlement before calling.
// ─────────────────────────────────────────────────────────────────────────────
export const settlementAbi = [
  {
    type: "function",
    name: "settlementFeeBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "mintingFeeBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "feeRecipients",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "treasury", type: "address" },
          { name: "team", type: "address" },
          { name: "ecosystem", type: "address" },
          { name: "insurance", type: "address" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "settleEnergy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "provider", type: "address" },
      { name: "tokenAmount", type: "uint256" },
      { name: "kwhConsumed", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "crossVPPSettle",
    stateMutability: "nonpayable",
    inputs: [
      { name: "receiver", type: "address" },
      { name: "counterpartyVPPId", type: "bytes32" },
      { name: "tokenAmount", type: "uint256" },
    ],
    outputs: [],
  },
  // Events — match contracts/interfaces/ISettlement.sol verbatim.
  {
    type: "event",
    name: "EnergySettled",
    inputs: [
      { name: "payer", type: "address", indexed: true },
      { name: "provider", type: "address", indexed: true },
      { name: "tokensTransferred", type: "uint256", indexed: false },
      { name: "kwhConsumed", type: "uint256", indexed: false },
      { name: "feePaid", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "CrossVPPSettled",
    inputs: [
      { name: "payer", type: "address", indexed: true },
      { name: "receiver", type: "address", indexed: true },
      { name: "counterpartyVPPId", type: "bytes32", indexed: true },
      { name: "tokensTransferred", type: "uint256", indexed: false },
      { name: "feePaid", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "FeesDistributed",
    inputs: [
      { name: "treasuryAmt", type: "uint256", indexed: false },
      { name: "teamAmt", type: "uint256", indexed: false },
      { name: "ecosystemAmt", type: "uint256", indexed: false },
      { name: "insuranceAmt", type: "uint256", indexed: false },
    ],
  },
] as const satisfies Abi;

/** Halving schedule from Technical_Blueprint.md §5. Used by the Tokenomics page. */
export const HALVING_SCHEDULE: ReadonlyArray<{
  era: number;
  supplyStart: number;
  supplyEnd: number;
  rateTokenPerKwh: number;
  energyForEraKwh: number;
}> = [
  { era: 0, supplyStart: 0, supplyEnd: 1_000_000, rateTokenPerKwh: 1.0, energyForEraKwh: 1_000_000 },
  { era: 1, supplyStart: 1_000_000, supplyEnd: 2_000_000, rateTokenPerKwh: 0.5, energyForEraKwh: 2_000_000 },
  { era: 2, supplyStart: 2_000_000, supplyEnd: 3_000_000, rateTokenPerKwh: 0.25, energyForEraKwh: 4_000_000 },
  { era: 3, supplyStart: 3_000_000, supplyEnd: 4_000_000, rateTokenPerKwh: 0.125, energyForEraKwh: 8_000_000 },
  { era: 4, supplyStart: 4_000_000, supplyEnd: 5_000_000, rateTokenPerKwh: 0.0625, energyForEraKwh: 16_000_000 },
  { era: 5, supplyStart: 5_000_000, supplyEnd: 6_000_000, rateTokenPerKwh: 0.03125, energyForEraKwh: 32_000_000 },
  { era: 6, supplyStart: 6_000_000, supplyEnd: 7_000_000, rateTokenPerKwh: 0.015625, energyForEraKwh: 64_000_000 },
  { era: 7, supplyStart: 7_000_000, supplyEnd: 8_000_000, rateTokenPerKwh: 0.0078125, energyForEraKwh: 128_000_000 },
];
