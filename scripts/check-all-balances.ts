import { ethers } from "hardhat";
async function main() {
  const TOKEN = "0x8557e39A372FAC1811b2171207B669975B648fDB";
  const SETTLEMENT = "0xBaFe8D465F9D7fCab723e41c0bA13D328b2E4C9C";
  const VPP = "0x309B188b95dCB2523DeAC526FAC98E19598b24A3";
  const DEPLOYER = "0x92a825909dcC69591618209ABa8Df71f1F06A91e";
  const ENGINE = "0x223cEf9882f5F7528CCC4521773683B83723B5A4";

  const token = await ethers.getContractAt("XRGYToken", TOKEN);
  console.log("Settlement contract balance:", ethers.formatUnits(await token.balanceOf(SETTLEMENT), 18));
  console.log("MintingEngine balance:      ", ethers.formatUnits(await token.balanceOf(ENGINE), 18));
  console.log("VPP balance:                ", ethers.formatUnits(await token.balanceOf(VPP), 18));
  console.log("Deployer balance:           ", ethers.formatUnits(await token.balanceOf(DEPLOYER), 18));
  console.log("Total supply:               ", ethers.formatUnits(await token.totalSupply(), 18));
}
main().catch(e => { console.error(e); process.exit(1); });
