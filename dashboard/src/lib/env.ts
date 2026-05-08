import type { Address } from "viem";

/**
 * Centralised, typed access to Vite env vars. We do NOT throw on missing
 * contract addresses — the dashboard renders a "not deployed" banner instead.
 * That keeps the design demo-able even before the contracts agent ships.
 */

function asAddress(value: string | undefined, fallback: Address): Address {
  if (!value) return fallback;
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
    // eslint-disable-next-line no-console
    console.warn(`[env] Invalid address: ${value}, falling back to zero.`);
    return fallback;
  }
  return value as Address;
}

const ZERO: Address = "0x0000000000000000000000000000000000000000";

export const env = {
  arbitrumSepoliaRpc:
    import.meta.env.VITE_ARBITRUM_SEPOLIA_RPC ||
    "https://sepolia-rollup.arbitrum.io/rpc",

  xrgyTokenAddress: asAddress(import.meta.env.VITE_XRGY_TOKEN_ADDRESS, ZERO),
  mintingEngineAddress: asAddress(
    import.meta.env.VITE_MINTING_ENGINE_ADDRESS,
    ZERO,
  ),
  oracleRouterAddress: asAddress(
    import.meta.env.VITE_ORACLE_ROUTER_ADDRESS,
    ZERO,
  ),
  settlementAddress: asAddress(import.meta.env.VITE_SETTLEMENT_ADDRESS, ZERO),

  walletConnectProjectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "",

  demoMode:
    (import.meta.env.VITE_DEMO_MODE || "true").toLowerCase() === "true",
} as const;
