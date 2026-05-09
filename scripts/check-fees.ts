import { ethers } from "hardhat";

async function main() {
  const TOKEN = "0x8557e39A372FAC1811b2171207B669975B648fDB";
  const VPP = "0x309B188b95dCB2523DeAC526FAC98E19598b24A3";
  const DEPLOYER = "0x92a825909dcC69591618209ABa8Df71f1F06A91e";

  const token = await ethers.getContractAt("XRGYToken", TOKEN);
  const vpp = await token.balanceOf(VPP);
  const dep = await token.balanceOf(DEPLOYER);
  const supply = await token.totalSupply();

  console.log("VPP cloud (smoke-vpp):", ethers.formatUnits(vpp, 18), "XRGY");
  console.log("Deployer (= treasury+team+ecosystem+insurance):", ethers.formatUnits(dep, 18), "XRGY");
  console.log("Total supply:", ethers.formatUnits(supply, 18), "XRGY");
}
main().catch(e => { console.error(e); process.exit(1); });
