import { useReadContract } from "wagmi";

import { mintingEngineAbi } from "@/lib/contracts";
import { contractAddresses } from "@/wagmi";

/**
 * Reads `getFloatingIndex()` from MintingEngine.
 *
 * Definition (Technical_Blueprint §2.2):
 *   floatingIndex = totalVerifiedEnergyInStorage / totalSupply
 *
 * Returned as 1e18-scaled bigint. Format with `formatFloatingIndex()`.
 *
 * This is the most important number on the dashboard — it is the live
 * energy-density of every $XRGY in circulation. As the network halves,
 * this should tick UP (each token represents more stored kWh).
 */
export function useFloatingIndex(): {
  data: bigint | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const { data, isLoading, error, refetch } = useReadContract({
    address: contractAddresses.mintingEngine,
    abi: mintingEngineAbi,
    functionName: "getFloatingIndex",
    query: {
      // Index changes only at epoch settlements (24h). Fast staleness is fine.
      staleTime: 30_000,
      refetchInterval: 60_000,
    },
  });

  return {
    data: data as bigint | undefined,
    isLoading,
    error: error as Error | null,
    refetch: () => void refetch(),
  };
}
