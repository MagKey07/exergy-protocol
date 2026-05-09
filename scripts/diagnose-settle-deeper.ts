import { ethers } from "hardhat";
async function main() {
  const SETTLEMENT = "0xBaFe8D465F9D7fCab723e41c0bA13D328b2E4C9C";
  const TOKEN = "0x8557e39A372FAC1811b2171207B669975B648fDB";
  const VPP = "0x309B188b95dCB2523DeAC526FAC98E19598b24A3";

  const settlement = await ethers.getContractAt("Settlement", SETTLEMENT);
  console.log("Settlement.token():        ", await settlement.token());
  console.log("Expected (XRGYToken):      ", TOKEN);
  console.log();

  const token = await ethers.getContractAt("XRGYToken", TOKEN);
  console.log("VPP balance:    ", ethers.formatUnits(await token.balanceOf(VPP), 18));
  console.log("VPP allowance(Settlement):", ethers.formatUnits(await token.allowance(VPP, SETTLEMENT), 18));
  console.log();

  // Try actual call from MintingEngine address
  const ENGINE = "0x223cEf9882f5F7528CCC4521773683B83723B5A4";
  const provider = ethers.provider;
  
  // Impersonate engine
  await provider.send("hardhat_impersonateAccount", [ENGINE]);
  // Cannot impersonate on real testnet. Skip.
  
  // Use eth_call with from override
  const data = settlement.interface.encodeFunctionData("collectMintingFee", [VPP, ethers.parseEther("1")]);
  console.log("Trying eth_call simulate from MintingEngine (currently latest state)...");
  try {
    const result = await provider.call({
      to: SETTLEMENT,
      from: ENGINE,
      data,
    });
    console.log("  ✓ would return:", BigInt(result).toString(), "wei (=", ethers.formatUnits(BigInt(result), 18), "XRGY fee)");
  } catch (e: any) {
    console.log("  ✗ would revert:", e.shortMessage || e.message?.slice(0,200));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
