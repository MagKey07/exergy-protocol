import { useReadContracts } from "wagmi";

import { mintingEngineAbi, xrgyTokenAbi, EPOCH_DURATION_SECONDS } from "@/lib/contracts";
import { contractAddresses } from "@/wagmi";

/**
 * Network-wide protocol stats consumed by Overview + Tokenomics.
 *
 * Single multicall:
 *   xrgy.totalSupply
 *   xrgy.symbol
 *   mintingEngine.totalVerifiedEnergyInStorage
 *   mintingEngine.currentEpoch
 *
 * Note: `totalEnergyEverVerified` is not exposed on-chain — it is derived
 * client-side in Overview from the sum of `EnergyMinted.kwhAmount` events.
 * `epochLength` is a `EPOCH_DURATION` constant in the contract (1 days),
 * surfaced here as a hardcoded value rather than an RPC call.
 */
export interface ProtocolStats {
  totalSupply: bigint | undefined;
  tokenSymbol: string | undefined;
  totalVerifiedEnergyInStorage: bigint | undefined;
  currentEpoch: bigint | undefined;
  epochLength: bigint;
}

export function useProtocolStats(): {
  data: ProtocolStats;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const result = useReadContracts({
    contracts: [
      { address: contractAddresses.xrgyToken, abi: xrgyTokenAbi, functionName: "totalSupply" },
      { address: contractAddresses.xrgyToken, abi: xrgyTokenAbi, functionName: "symbol" },
      { address: contractAddresses.mintingEngine, abi: mintingEngineAbi, functionName: "totalVerifiedEnergyInStorage" },
      { address: contractAddresses.mintingEngine, abi: mintingEngineAbi, functionName: "currentEpoch" },
    ],
    query: {
      staleTime: 30_000,
      refetchInterval: 60_000,
    },
  });

  const r = result.data;
  return {
    data: {
      totalSupply: r?.[0]?.result as bigint | undefined,
      tokenSymbol: r?.[1]?.result as string | undefined,
      totalVerifiedEnergyInStorage: r?.[2]?.result as bigint | undefined,
      currentEpoch: r?.[3]?.result as bigint | undefined,
      epochLength: EPOCH_DURATION_SECONDS,
    },
    isLoading: result.isLoading,
    error: result.error as Error | null,
    refetch: () => void result.refetch(),
  };
}
