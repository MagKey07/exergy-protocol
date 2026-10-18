// Read-only: simulate one mint on the live network as the OracleRouter (eth_call — nothing is written)
// and decode the events it would emit, to confirm the live contracts split the mint 89/10/1.
import fs from "fs";
import path from "path";
import { ethers } from "hardhat";

async function main() {
  const c = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../deployments/arbitrumSepolia.json"), "utf-8")).contracts;
  const engine = await ethers.getContractAt("MintingEngine", c.MintingEngine);
  const token = await ethers.getContractAt("XRGYToken", c.XRGYToken);
  const kwh = ethers.parseEther("100");
  const vpp = "0x000000000000000000000000000000000000bEEF";
  const data = engine.interface.encodeFunctionData("commitVerifiedEnergy", [ethers.id("static-check-device"), vpp, kwh, 1, kwh, 100]);
  const ret = await ethers.provider.call({ to: c.MintingEngine, from: c.OracleRouter, data });
  const minted = engine.interface.decodeFunctionResult("commitVerifiedEnergy", ret)[0];
  console.log("would mint:", ethers.formatEther(minted), "notes for 100 kWh (era", (await engine.currentEra()).toString() + ")");
  const share = await engine.keyShareBps();
  const toTreasury = (minted * share) / 10000n;
  const toReserve = (minted * (await engine.RESERVE_SHARE_BPS())) / 10000n;
  console.log("keyShareBps:", share.toString(), "→ treasury", ethers.formatEther(toTreasury), "| reserve", ethers.formatEther(toReserve), "| community", ethers.formatEther(minted - toTreasury - toReserve));
  console.log("supply unchanged on chain:", ethers.formatEther(await token.totalSupply()));
}
main().catch((e) => { console.error(e); process.exit(1); });
