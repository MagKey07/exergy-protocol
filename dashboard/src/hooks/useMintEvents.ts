import { useEffect, useMemo, useState } from "react";
import { usePublicClient } from "wagmi";
import type { Address, Log } from "viem";
import { parseAbiItem } from "viem";

import { contractAddresses, contractsConfigured } from "@/wagmi";

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

const TOKENS_MINTED = parseAbiItem(
  "event TokensMinted(address indexed vpp, uint256 indexed epoch, uint256 kwh, uint256 tokens)",
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
        const logs = await client.getLogs({
          address: contractAddresses.mintingEngine,
          event: TOKENS_MINTED,
          args: vpp ? { vpp } : undefined,
          fromBlock: "earliest",
          toBlock: "latest",
        });

        const sorted = (logs as Array<
          Log & { args: { vpp: Address; epoch: bigint; kwh: bigint; tokens: bigint } }
        >)
          .map<MintEvent>((log) => ({
            vpp: log.args.vpp,
            epoch: log.args.epoch,
            kwh: log.args.kwh,
            tokens: log.args.tokens,
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
