import { ethers } from "hardhat";
async function main() {
  const SETTLEMENT = "0xBaFe8D465F9D7fCab723e41c0bA13D328b2E4C9C";
  const ENGINE = "0x223cEf9882f5F7528CCC4521773683B83723B5A4";
  const VPP = "0x309B188b95dCB2523DeAC526FAC98E19598b24A3";
  const TOKEN = "0x8557e39A372FAC1811b2171207B669975B648fDB";

  const settlement = await ethers.getContractAt("Settlement", SETTLEMENT);
  const token = await ethers.getContractAt("XRGYToken", TOKEN);
  
  console.log("Settlement.mintingEngine():", await settlement.mintingEngine());
  console.log("Expected (proxy):         ", ENGINE);
  console.log();
  console.log("Settlement.mintingFeeBps():", await settlement.mintingFeeBps());
  console.log("Settlement.settlementFeeBps():", await settlement.settlementFeeBps());
  console.log();
  console.log("VPP allowance(VPP, Settlement):", ethers.formatUnits(await token.allowance(VPP, SETTLEMENT), 18));
}
main().catch(e => { console.error(e); process.exit(1); });
