// Fix fee distribution flow:
// 1. Fund VPP cloud wallet with ETH for gas (Sepolia)
// 2. VPP cloud approve(settlement, max) on XRGYToken
//
// After this, every subsequent mint will have its 1% fee actually transferred
// to the 4 fee receivers (treasury/team/ecosystem/insurance), not silently skipped.

import fs from "fs";
import path from "path";
import { ethers, network } from "hardhat";

async function main() {
  const file = path.resolve(__dirname, `../deployments/${network.name}.json`);
  const book = JSON.parse(fs.readFileSync(file, "utf-8"));

  const TOKEN = book.contracts.XRGYToken;
  const SETTLEMENT = book.contracts.Settlement;

  // VPP cloud — deterministic key (matches simulator's fromSeed)
  const vppCloudPk = ethers.keccak256(
    ethers.toUtf8Bytes("exergy-sim:vpp:smoke-vpp"),
  );
  const vppCloudWallet = new ethers.Wallet(vppCloudPk, ethers.provider);
  const vppCloudAddr = vppCloudWallet.address;

  const [deployer] = await ethers.getSigners();

  console.log("=== Fee approve setup ===");
  console.log("VPP cloud:    ", vppCloudAddr);
  console.log("Settlement:   ", SETTLEMENT);
  console.log("Deployer:     ", deployer.address);
  console.log();

  // Check VPP cloud ETH balance
  const vppEth = await ethers.provider.getBalance(vppCloudAddr);
  console.log("VPP cloud ETH balance:", ethers.formatEther(vppEth));

  if (vppEth < ethers.parseEther("0.001")) {
    console.log("Funding VPP cloud with 0.005 ETH for gas...");
    const txFund = await deployer.sendTransaction({
      to: vppCloudAddr,
      value: ethers.parseEther("0.005"),
    });
    await txFund.wait();
    const newBal = await ethers.provider.getBalance(vppCloudAddr);
    console.log("  ✓ Funded. New balance:", ethers.formatEther(newBal), "ETH");
  } else {
    console.log("VPP cloud already funded.");
  }
  console.log();

  // VPP cloud approves Settlement
  const token = await ethers.getContractAt("XRGYToken", TOKEN, vppCloudWallet);
  const currentAllowance = await token.allowance(vppCloudAddr, SETTLEMENT);
  console.log("Current allowance:", ethers.formatUnits(currentAllowance, 18));

  if (currentAllowance < ethers.MaxUint256 / 2n) {
    console.log("Approving max...");
    const txApprove = await token.approve(SETTLEMENT, ethers.MaxUint256);
    await txApprove.wait();
    console.log("  ✓ Approved. tx:", txApprove.hash);
  } else {
    console.log("Already approved.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
