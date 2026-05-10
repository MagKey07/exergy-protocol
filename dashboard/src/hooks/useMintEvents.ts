import { useEffect, useMemo, useState } from "react";
import { usePublicClient } from "wagmi";
import type { Address, Log } from "viem";
import { parseAbiItem } from "viem";

import { contractAddresses, contractsConfigured } from "@/wagmi";
import { getLogsChunked } from "@/lib/chunkedLogs";

/**
 * Recent mint events (per-VPP or network-wide). Drives:
 *  - Overview "recent epoch settlements" feed
 *  - MyVPP "recent epoch mints" list
 *
 * Phase 1 will replace this with subgraph pagination. The shape stays the
 * same, so call-sites don't need to change.
 */
export interface MintEvent {
  vpp: Address;
  epoch: bigint;
  kwh: bigint;
  tokens: bigint;
  blockNumber: bigint;
  txHash: `0x${string}`;
  timestamp?: bigint;
}

const ENERGY_MINTED = parseAbiItem(
  "event EnergyMinted(bytes32 indexed deviceId, address indexed vppAddress, uint256 kwhAmount, uint256 tokensMinted, uint256 indexed epoch, uint256 era)",
);

export function useMintEvents(opts?: {
  vpp?: Address;
  limit?: number;
}): { data: MintEvent[]; isLoading: boolean; error: Error | null } {
  const client = usePublicClient();
  const [data, setData] = useState<MintEvent[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);

  const limit = opts?.limit ?? 25;
  const vpp = opts?.vpp;

  const enabled = useMemo(
    () => Boolean(client && contractsConfigured()),
    [client],
  );

  useEffect(() => {
    if (!enabled || !client) {
      setData([]);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    (async () => {
      try {
        const logs = await getLogsChunked(client, {
          address: contractAddresses.mintingEngine,
          event: ENERGY_MINTED,
          args: vpp ? { vppAddress: vpp } : undefined,
          fromBlock: BigInt(import.meta.env.VITE_DEPLOY_BLOCK ?? "0"),
        });

        const sorted = (logs as Array<
          Log & {
            args: {
              deviceId: `0x${string}`;
              vppAddress: Address;
              kwhAmount: bigint;
              tokensMinted: bigint;
              epoch: bigint;
              era: bigint;
            };
          }
        >)
          .map<MintEvent>((log) => ({
            vpp: log.args.vppAddress,
            epoch: log.args.epoch,
            kwh: log.args.kwhAmount,
            tokens: log.args.tokensMinted,
            blockNumber: log.blockNumber ?? 0n,
            txHash: log.transactionHash ?? "0x",
          }))
          .sort((a, b) => Number(b.blockNumber - a.blockNumber))
          .slice(0, limit);

        if (!cancelled) setData(sorted);
      } catch (e) {
        if (!cancelled) setError(e as Error);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, client, vpp, limit]);

  return { data, isLoading, error };
}
