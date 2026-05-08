import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { arbitrumSepolia } from "wagmi/chains";
import { http } from "wagmi";
import type { Address } from "viem";

import { env } from "@/lib/env";

/**
 * Wagmi + RainbowKit config.
 *
 * Phase 0 lives entirely on Arbitrum Sepolia. Production / Phase 2 will add
 * arbitrum mainnet to the chains array; nothing else in the dashboard should
 * have to change because all reads use `useReadContract` against the contract
 * addresses below, which are env-driven.
 */
export const wagmiConfig = getDefaultConfig({
  appName: "Exergy Protocol",
  appDescription:
    "Energy-backed monetary settlement layer. Operator + observer dashboard.",
  appUrl: "https://exergy.protocol",
  projectId: env.walletConnectProjectId || "exergy-dev-no-wc",
  chains: [arbitrumSepolia],
  transports: {
    [arbitrumSepolia.id]: http(env.arbitrumSepoliaRpc),
  },
  ssr: false,
});

/**
 * Phase 0 deployment is single-network. Whenever a hook needs the active
 * chain, it should read this constant rather than hard-coding the id, so
 * adding mainnet later is a one-file change.
 */
export const ACTIVE_CHAIN = arbitrumSepolia;

export interface ContractAddresses {
  xrgyToken: Address;
  mintingEngine: Address;
  oracleRouter: Address;
  settlement: Address;
}

export const contractAddresses: ContractAddresses = {
  xrgyToken: env.xrgyTokenAddress,
  mintingEngine: env.mintingEngineAddress,
  oracleRouter: env.oracleRouterAddress,
  settlement: env.settlementAddress,
};

/** Quick predicate used by gating UI when contracts haven't been deployed yet. */
export function contractsConfigured(): boolean {
  const zero = "0x0000000000000000000000000000000000000000";
  return Object.values(contractAddresses).every(
    (a) => a && a.toLowerCase() !== zero,
  );
}
