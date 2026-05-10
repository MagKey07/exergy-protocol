import type { AbiEvent, Address, Log, PublicClient } from "viem";

/**
 * Many free Arbitrum RPC providers cap `eth_getLogs` at 50,000 blocks per
 * request (publicnode.com returns `code: -32701` past that). The Phase 0
 * dashboard reads from deploy block to head, so by the time the network has
 * any history the naive single-call query starts to silently return empty.
 *
 * This helper iterates from `fromBlock` to the current head in fixed-size
 * windows and concatenates the result. Phase 1 swaps the call sites for a
 * subgraph and this file goes away entirely.
 */
export async function getLogsChunked<TEvent extends AbiEvent>(
  client: PublicClient,
  params: {
    address: Address;
    event: TEvent;
    args?: Record<string, unknown>;
    fromBlock: bigint;
    chunkSize?: bigint;
  },
): Promise<Log[]> {
  const chunkSize = params.chunkSize ?? 49_000n;
  const head = await client.getBlockNumber();
  const all: Log[] = [];

  let cursor = params.fromBlock;
  while (cursor <= head) {
    const end = cursor + chunkSize - 1n > head ? head : cursor + chunkSize - 1n;
    const logs = await client.getLogs({
      address: params.address,
      event: params.event,
      args: params.args,
      fromBlock: cursor,
      toBlock: end,
    } as Parameters<PublicClient["getLogs"]>[0]);
    all.push(...(logs as Log[]));
    cursor = end + 1n;
  }
  return all;
}
