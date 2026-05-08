import { useReadContracts } from "wagmi";

import { mintingEngineAbi, HALVING_SCHEDULE } from "@/lib/contracts";
import { contractAddresses } from "@/wagmi";

/**
 * Reads `getCurrentEra()` and `getCurrentRate()` in a single multicall.
 *
 * Era rate halves every 1M tokens minted (Technical_Blueprint §5).
 * The rate is 1e18-scaled tokens-per-kWh:
 *   Era 0 → 1e18 (1.0 token / kWh)
 *   Era 1 → 5e17 (0.5 token / kWh)
 *   Era N → 1e18 / 2^N
 *
 * This hook also returns the *static* projection from HALVING_SCHEDULE so the
 * UI can render the "next halving at X tokens" hint even before the chain
 * answers, eliminating a flash of empty state.
 */
export interface EraRateData {
  era: bigint | undefined;
  rate: bigint | undefined; // 1e18-scaled token/kWh
  /** Tokens minted threshold at which the next halving fires. */
  nextHalvingAtSupply: number | undefined;
  /** Energy budget for the current era (informational). */
  energyForEraKwh: number | undefined;
}

export function useEraRate(): {
  data: EraRateData;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const result = useReadContracts({
    contracts: [
      {
        address: contractAddresses.mintingEngine,
        abi: mintingEngineAbi,
        functionName: "getCurrentEra",
      },
      {
        address: contractAddresses.mintingEngine,
        abi: mintingEngineAbi,
        functionName: "getCurrentRate",
      },
    ],
    query: {
      staleTime: 30_000,
      refetchInterval: 60_000,
    },
  });

  const era = result.data?.[0]?.result as bigint | undefined;
  const rate = result.data?.[1]?.result as bigint | undefined;

  let nextHalvingAtSupply: number | undefined;
  let energyForEraKwh: number | undefined;
  if (era !== undefined) {
    const eraNum = Number(era);
    const row = HALVING_SCHEDULE[eraNum];
    if (row) {
      nextHalvingAtSupply = row.supplyEnd;
      energyForEraKwh = row.energyForEraKwh;
    }
  }

  return {
    data: { era, rate, nextHalvingAtSupply, energyForEraKwh },
    isLoading: result.isLoading,
    error: result.error as Error | null,
    refetch: () => void result.refetch(),
  };
}
