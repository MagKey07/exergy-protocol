// One-off: the original deploy passed the halving threshold already in wei
// (parseEther("1000000")) to an initializer that expects WHOLE tokens and
// multiplies by 1e18 itself — leaving the threshold at 1e24 tokens instead of
// 1,000,000. This sets it to the spec value: 1,000,000 notes (1e24 wei).
import { ethers } from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
  const book = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../deployments/arbitrumSepolia.json"), "utf-8"),
  );
  const engine = await ethers.getContractAt("MintingEngine", book.contracts.MintingEngine);
  const target = ethers.parseEther("1000000"); // 1,000,000 notes in wei
  console.log("before:", (await engine.halvingThreshold()).toString());
  const tx = await engine.adminSetHalvingThreshold(target);
  await tx.wait();
  console.log("tx:", tx.hash);
  console.log("after: ", (await engine.halvingThreshold()).toString());
  console.log("era:   ", (await engine.currentEra()).toString());
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
