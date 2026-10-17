// Builds public/chain-snapshot.json: every log emitted by the Exergy contracts
// on Arbitrum Sepolia, pulled from the Etherscan v2 API. The dashboard reads
// history from this file and scans only the blocks after it live, because
// scanning tens of millions of blocks through a public RPC never finishes.
// Run before each dashboard deploy: node scripts/snapshot-logs.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, ".env"), "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const key = fs.readFileSync(path.join(root, "..", ".env"), "utf8").match(/ARBISCAN_API_KEY=(\S+)/)[1];
const addresses = [
  env.VITE_XRGY_TOKEN_ADDRESS, env.VITE_MINTING_ENGINE_ADDRESS, env.VITE_ORACLE_ROUTER_ADDRESS,
  env.VITE_SETTLEMENT_ADDRESS, env.VITE_PROTOCOL_GOVERNANCE_ADDRESS,
].map((a) => a.toLowerCase());
const fromBlock = Number(env.VITE_DEPLOY_BLOCK);

async function api(params) {
  const url = "https://api.etherscan.io/v2/api?chainid=421614&" + new URLSearchParams({ ...params, apikey: key });
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await (await fetch(url)).json();
    if (Array.isArray(r.result)) return r.result;
    if (r.message === "No records found") return [];
    await new Promise((s) => setTimeout(s, 1000 * (attempt + 1)));
  }
  throw new Error("Etherscan API kept failing: " + url.replace(key, "***"));
}

const toBlock = parseInt(
  (await (await fetch("https://api.etherscan.io/v2/api?chainid=421614&module=proxy&action=eth_blockNumber&apikey=" + key)).json()).result,
  16,
);

const logs = [];
for (const address of addresses) {
  // The API caps a page at 1000 logs; walk forward by block instead of by page.
  let cursor = fromBlock;
  for (;;) {
    const batch = await api({ module: "logs", action: "getLogs", address, fromBlock: cursor, toBlock, page: 1, offset: 1000 });
    logs.push(...batch);
    if (batch.length < 1000) break;
    const last = parseInt(batch[batch.length - 1].blockNumber, 16);
    // Drop the last block's logs and refetch it whole so nothing is cut in half.
    while (logs.length && parseInt(logs[logs.length - 1].blockNumber, 16) === last) logs.pop();
    cursor = last;
  }
  await new Promise((s) => setTimeout(s, 250));
}

const out = {
  chainId: 421614,
  fromBlock,
  toBlock,
  generatedAt: new Date().toISOString(),
  logs: logs.map((l) => ({
    address: l.address.toLowerCase(),
    topics: l.topics.filter(Boolean),
    data: l.data,
    blockNumber: parseInt(l.blockNumber, 16),
    timeStamp: parseInt(l.timeStamp, 16),
    logIndex: parseInt(l.logIndex || "0x0", 16),
    transactionHash: l.transactionHash,
  })),
};
fs.mkdirSync(path.join(root, "public"), { recursive: true });
fs.writeFileSync(path.join(root, "public", "chain-snapshot.json"), JSON.stringify(out));
console.log(`snapshot: ${out.logs.length} logs, blocks ${fromBlock}..${toBlock}`);
