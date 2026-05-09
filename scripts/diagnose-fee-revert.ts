import { ethers } from "hardhat";

async function main() {
  const SETTLEMENT = "0xBaFe8D465F9D7fCab723e41c0bA13D328b2E4C9C";
  const ENGINE = "0x223cEf9882f5F7528CCC4521773683B83723B5A4";
  const VPP = "0x309B188b95dCB2523DeAC526FAC98E19598b24A3";

  const settlement = await ethers.getContractAt("Settlement", SETTLEMENT);
  const provider = ethers.provider;

  console.log("Settlement.paused():", await settlement.paused());
  
  // Simulate collectMintingFee call from MintingEngine address
  const fragment = settlement.interface.getFunction("collectMintingFee");
  const data = settlement.interface.encodeFunctionData(fragment!, [VPP, ethers.parseEther("3")]);
  
  try {
    // Simulate as MintingEngine
    const result = await provider.call({
      to: SETTLEMENT,
      from: ENGINE,
      data: data,
    });
    console.log("Simulate succeed:", result);
  } catch (e: any) {
    console.log("Simulate REVERTED with:");
    console.log("  message:", e.message?.slice(0,200));
    if (e.data) console.log("  data:", e.data.slice(0,200));
    if (e.shortMessage) console.log("  short:", e.shortMessage);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
