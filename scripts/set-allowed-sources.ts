// Turn on the energy sources whose stored energy may mint: solar (0), wind (1), hydro (2).
// "Other" (3) stays off; grid power has no source code at all.
// Usage: npx hardhat run --network arbitrumSepolia scripts/set-allowed-sources.ts
import fs from "fs";
import path from "path";
import { ethers, network } from "hardhat";

async function main() {
  const book = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../deployments/${network.name}.json`), "utf-8"));
  const router = await ethers.getContractAt("OracleRouter", book.contracts.OracleRouter);
  for (const source of [0, 1, 2]) {
    if (await router.isSourceAllowed(source)) { console.log(`source ${source}: already allowed`); continue; }
    const tx = await router.setAllowedSource(source, true);
    await tx.wait();
    console.log(`source ${source}: allowed · ${tx.hash}`);
  }
  for (const source of [0, 1, 2, 3]) console.log(`isSourceAllowed(${source}) = ${await router.isSourceAllowed(source)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
