import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { arbitrumSepolia } from "wagmi/chains";
import { http } from "wagmi";
import type { Address } from "viem";
import { defineChain } from "viem";

import { env } from "@/lib/env";

/**
 * Local Hardhat chain (chainId 31337). Used for in-process / persistent
 * `npx hardhat node` development. Removed when migrating to Sepolia.
 */
export const hardhatLocal = defineChain({
  id: 31337,
  name: "Hardhat Local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["http://127.0.0.1:8545"] },
    public: { http: ["http://127.0.0.1:8545"] },
  },
});

const useLocal =
  import.meta.env.VITE_USE_LOCAL === "true" ||
  env.arbitrumSepoliaRpc.includes("127.0.0.1") ||
  env.arbitrumSepoliaRpc.includes("localhost");

const ACTIVE = useLocal ? hardhatLocal : arbitrumSepolia;

/**
 * Wagmi + RainbowKit config.
 */
export const wagmiConfig = getDefaultConfig({
  appName: "Exergy Protocol",
  appDescription:
    "Energy-backed monetary settlement layer. Operator + observer dashboard.",
  appUrl: "https://exergy.protocol",
  projectId: env.walletConnectProjectId || "exergy-dev-no-wc",
  chains: [ACTIVE],
  transports: {
    [ACTIVE.id]: http(env.arbitrumSepoliaRpc),
  },
  ssr: false,
});

export const ACTIVE_CHAIN = ACTIVE;

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
