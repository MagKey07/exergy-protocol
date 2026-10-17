import type { AbiEvent, Address, Hex, Log, PublicClient } from "viem";
import { decodeEventLog, toEventSelector } from "viem";

/**
 * Many free Arbitrum RPC providers cap `eth_getLogs` at 50,000 blocks per
 * request (publicnode.com returns `code: -32701` past that), and the range
 * from our deploy block is now tens of millions of blocks — a full scan
 * through a public RPC never finishes.
 *
 * So history comes from `/chain-snapshot.json` (every log the Exergy
 * contracts emitted, built by `scripts/snapshot-logs.mjs` before each
 * deploy), and only the blocks after the snapshot are scanned live, in
 * fixed-size windows. Phase 1 swaps the call sites for a subgraph and this
 * file goes away entirely.
 */

interface SnapshotLog {
  address: string;
  topics: Hex[];
  data: Hex;
  blockNumber: number;
  logIndex: number;
  transactionHash: Hex;
}

interface Snapshot {
  toBlock: number;
  logs: SnapshotLog[];
}

let snapshotPromise: Promise<Snapshot | null> | null = null;

function loadSnapshot(): Promise<Snapshot | null> {
  if (!snapshotPromise) {
    snapshotPromise = fetch("/chain-snapshot.json")
      .then((r) => (r.ok ? (r.json() as Promise<Snapshot>) : null))
      .catch(() => null);
  }
  return snapshotPromise;
}

function argsMatch(
  decoded: Record<string, unknown>,
  filter: Record<string, unknown> | undefined,
): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([k, v]) => {
    if (v === undefined) return true;
    const actual = decoded[k];
    if (typeof v === "string" && typeof actual === "string") {
      return v.toLowerCase() === actual.toLowerCase();
    }
    return actual === v;
  });
}

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
  const all: Log[] = [];
  let cursor = params.fromBlock;

  const snapshot = await loadSnapshot();
  if (snapshot) {
    const selector = toEventSelector(params.event);
    const address = params.address.toLowerCase();
    for (const l of snapshot.logs) {
      if (l.address !== address || l.topics[0] !== selector) continue;
      if (BigInt(l.blockNumber) < params.fromBlock) continue;
      const decoded = decodeEventLog({
        abi: [params.event],
        topics: l.topics as [Hex, ...Hex[]],
        data: l.data,
      }) as unknown as { args: Record<string, unknown> };
      if (!argsMatch(decoded.args, params.args)) continue;
      all.push({
        address: l.address as Address,
        topics: l.topics,
        data: l.data,
        args: decoded.args,
        blockNumber: BigInt(l.blockNumber),
        logIndex: l.logIndex,
        transactionHash: l.transactionHash,
      } as unknown as Log);
    }
    const next = BigInt(snapshot.toBlock) + 1n;
    if (next > cursor) cursor = next;
  }

  const head = await client.getBlockNumber();
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
