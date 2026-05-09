import { ethers } from "hardhat";

async function main() {
  const TOKEN_ADDR = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
  const ENGINE_ADDR = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0";
  const VPP_ADDR = "0x309B188b95dCB2523DeAC526FAC98E19598b24A3";

  const token = await ethers.getContractAt("XRGYToken", TOKEN_ADDR);
  const engine = await ethers.getContractAt("MintingEngine", ENGINE_ADDR);

  const supply = await token.totalSupply();
  const vppBalance = await token.balanceOf(VPP_ADDR);
  const tve = await engine.totalVerifiedEnergyInStorage();
  const fi = await engine.getFloatingIndex();
  const era = await engine.currentEra();
  const rate = await engine.currentMintRateWeiPerKwh();

  console.log("======================================================");
  console.log(" PROTOCOL STATE (after 5 kWh dual-signed packet)");
  console.log("======================================================");
  console.log("Total $XRGY supply:           ", ethers.formatUnits(supply, 18));
  console.log("VPP cloud balance ($XRGY):    ", ethers.formatUnits(vppBalance, 18));
  console.log("Total verified energy (kWh):  ", ethers.formatUnits(tve, 18));
  console.log("Floating index (kWh per token):", ethers.formatUnits(fi, 18));
  console.log("Current era:                  ", era.toString());
  console.log("Current rate (token/kWh):     ", ethers.formatUnits(rate, 18));
  console.log("======================================================");
}

main().catch(e => { console.error(e); process.exit(1); });
