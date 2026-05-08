import { useReadContracts } from "wagmi";

import { mintingEngineAbi, xrgyTokenAbi } from "@/lib/contracts";
import { contractAddresses } from "@/wagmi";

/**
 * Network-wide protocol stats consumed by Overview + Tokenomics.
 *
 * Single multicall:
 *   xrgy.totalSupply
 *   xrgy.symbol
 *   mintingEngine.totalVerifiedEnergyInStorage
 *   mintingEngine.totalEnergyEverVerified
 *   mintingEngine.currentEpoch
 *   mintingEngine.epochLength
 */
export interface ProtocolStats {
  totalSupply: bigint | undefined;
  tokenSymbol: string | undefined;
  totalVerifiedEnergyInStorage: bigint | undefined;
  totalEnergyEverVerified: bigint | undefined;
  currentEpoch: bigint | undefined;
  epochLength: bigint | undefined;
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
      { address: contractAddresses.mintingEngine, abi: mintingEngineAbi, functionName: "totalEnergyEverVerified" },
      { address: contractAddresses.mintingEngine, abi: mintingEngineAbi, functionName: "currentEpoch" },
      { address: contractAddresses.mintingEngine, abi: mintingEngineAbi, functionName: "epochLength" },
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
      totalEnergyEverVerified: r?.[3]?.result as bigint | undefined,
      currentEpoch: r?.[4]?.result as bigint | undefined,
      epochLength: r?.[5]?.result as bigint | undefined,
    },
    isLoading: result.isLoading,
    error: result.error as Error | null,
    refetch: () => void result.refetch(),
  };
}
