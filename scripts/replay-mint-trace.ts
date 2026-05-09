// Replay a failed mint on the local fork with impersonation + trace.
// Goal: find why fee collection silently swallows.

import { ethers, network } from "hardhat";

async function main() {
  const TOKEN = "0x8557e39A372FAC1811b2171207B669975B648fDB";
  const SETTLEMENT = "0xBaFe8D465F9D7fCab723e41c0bA13D328b2E4C9C";
  const ENGINE = "0x223cEf9882f5F7528CCC4521773683B83723B5A4";
  const VPP = "0x309B188b95dCB2523DeAC526FAC98E19598b24A3";

  // Impersonate MintingEngine to call Settlement directly
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [ENGINE],
  });
  // Use hardhat_setBalance to fund (sendTransaction fails since proxy has no receive())
  await network.provider.request({
    method: "hardhat_setBalance",
    params: [ENGINE, "0xDE0B6B3A7640000"], // 1 ETH
  });
  const engineSigner = await ethers.getSigner(ENGINE);

  const settlement = await ethers.getContractAt("Settlement", SETTLEMENT, engineSigner);
  const token = await ethers.getContractAt("XRGYToken", TOKEN);

  console.log("=== State before fee call ===");
  console.log("VPP balance:    ", ethers.formatUnits(await token.balanceOf(VPP), 18));
  console.log("VPP allowance(Settlement):", ethers.formatUnits(await token.allowance(VPP, SETTLEMENT), 18));
  console.log("Settlement.token():", await settlement.token());
  console.log("Settlement.mintingEngine():", await settlement.mintingEngine());
  console.log("Settlement.paused():", await settlement.paused());
  console.log();

  console.log("=== Direct call to collectMintingFee from MintingEngine impersonated ===");
  try {
    const tx = await settlement.collectMintingFee(VPP, ethers.parseEther("3"));
    const receipt = await tx.wait();
    console.log("✓ Success! Tx:", tx.hash);
    console.log("  Gas used:", receipt?.gasUsed.toString());
    console.log("  Logs count:", receipt?.logs.length);
    for (const l of receipt?.logs ?? []) {
      console.log("    log:", l.address, l.topics[0]?.slice(0, 14));
    }
  } catch (e: any) {
    console.log("✗ FAILED!");
    console.log("  message:", e.message?.slice(0, 300));
    console.log("  shortMessage:", e.shortMessage);
    console.log("  reason:", e.reason);
    if (e.data) console.log("  data:", e.data);
  }

  console.log();
  console.log("=== State after attempt ===");
  console.log("VPP balance:    ", ethers.formatUnits(await token.balanceOf(VPP), 18));
  console.log("Settlement balance:", ethers.formatUnits(await token.balanceOf(SETTLEMENT), 18));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
