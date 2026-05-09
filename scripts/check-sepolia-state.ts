import { ethers } from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
  const file = path.resolve(__dirname, "../deployments/arbitrumSepolia.json");
  const book = JSON.parse(fs.readFileSync(file, "utf-8"));

  const TOKEN = book.contracts.XRGYToken;
  const ENGINE = book.contracts.MintingEngine;
  const VPP = "0x309B188b95dCB2523DeAC526FAC98E19598b24A3";

  const token = await ethers.getContractAt("XRGYToken", TOKEN);
  const engine = await ethers.getContractAt("MintingEngine", ENGINE);

  const supply = await token.totalSupply();
  const vpp = await token.balanceOf(VPP);
  const tve = await engine.totalVerifiedEnergyInStorage();
  const fi = await engine.getFloatingIndex();
  const era = await engine.currentEra();
  const rate = await engine.currentMintRateWeiPerKwh();

  console.log("=========================================");
  console.log("  EXERGY PROTOCOL — Arbitrum Sepolia");
  console.log("=========================================");
  console.log("Total $XRGY supply:        ", ethers.formatUnits(supply, 18));
  console.log("Smoke VPP balance ($XRGY): ", ethers.formatUnits(vpp, 18));
  console.log("Total verified energy:     ", ethers.formatUnits(tve, 18), "kWh");
  console.log("Floating index:            ", ethers.formatUnits(fi, 18));
  console.log("Current era:               ", era.toString());
  console.log("Current mint rate:         ", ethers.formatUnits(rate, 18), "token/kWh");
  console.log("=========================================");
}

main().catch((e) => { console.error(e); process.exit(1); });
