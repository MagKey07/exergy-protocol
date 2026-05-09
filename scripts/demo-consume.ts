// Demo: imitates VPP energy consumption.
// VPP cloud has accumulated XRGY from charging (mint flow). Now demonstrate the
// other side: a settler "spends" tokens + records kWh consumed → floating index drops.
//
// This shows the Energy Asymmetry mechanism live.
//
// Usage: npx hardhat run --network localhost scripts/demo-consume.ts -- <kwhToConsume>

import fs from "fs";
import path from "path";
import { ethers, network } from "hardhat";

async function main() {
  const file = path.resolve(__dirname, `../deployments/${network.name}.json`);
  const book = JSON.parse(fs.readFileSync(file, "utf-8"));

  const TOKEN = book.contracts.XRGYToken;
  const SETTLEMENT = book.contracts.Settlement;
  const ENGINE = book.contracts.MintingEngine;

  // VPP cloud wallet (deterministic from simulator's fromSeed)
  const vppCloudPk = ethers.keccak256(
    ethers.toUtf8Bytes("exergy-sim:vpp:smoke-vpp"),
  );
  const vppCloudAddr = new ethers.Wallet(vppCloudPk).address;

  // Provider — deployer (admin) for demo simplicity (in real life, neighbor with energy)
  const [deployer] = await ethers.getSigners();

  console.log("==================================================");
  console.log(" Energy Asymmetry Demo — VPP consumes energy");
  console.log("==================================================");
  console.log("VPP cloud:    ", vppCloudAddr);
  console.log("Provider:     ", deployer.address);
  console.log();

  const token = await ethers.getContractAt("XRGYToken", TOKEN);
  const engine = await ethers.getContractAt("MintingEngine", ENGINE);
  const settlement = await ethers.getContractAt("Settlement", SETTLEMENT);

  // BEFORE
  const supply0 = await token.totalSupply();
  const tve0 = await engine.totalVerifiedEnergyInStorage();
  const fi0 = await engine.getFloatingIndex();
  console.log("BEFORE consumption:");
  console.log("  Total supply:    ", ethers.formatUnits(supply0, 18), "XRGY");
  console.log("  Energy storage:  ", ethers.formatUnits(tve0, 18), "kWh");
  console.log("  Floating index:  ", ethers.formatUnits(fi0, 18), "kWh/token");
  console.log();

  // Decide kWh to consume
  const arg = process.argv[process.argv.length - 1];
  const kwhToConsume = arg && !isNaN(Number(arg)) ? Number(arg) : 10;
  const kwhWei = ethers.parseEther(kwhToConsume.toString());
  const tokenAmount = kwhWei; // era 0: 1 token / 1 kWh

  // Impersonate VPP cloud (no gas needed, hardhat-only)
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [vppCloudAddr],
  });
  // Fund VPP cloud with ETH for gas
  await deployer.sendTransaction({
    to: vppCloudAddr,
    value: ethers.parseEther("1"),
  });
  const vppSigner = await ethers.getSigner(vppCloudAddr);

  console.log(`Step 1: VPP approves Settlement to spend ${kwhToConsume} XRGY...`);
  // Approve principal + 0.25% fee = 1.0025x
  const approveAmount = (tokenAmount * 10025n) / 10000n;
  const tx1 = await token
    .connect(vppSigner)
    .approve(SETTLEMENT, approveAmount);
  await tx1.wait();

  console.log(`Step 2: VPP settleEnergy(provider=${deployer.address}, ${kwhToConsume} XRGY, ${kwhToConsume} kWh)...`);
  const tx2 = await settlement
    .connect(vppSigner)
    .settleEnergy(deployer.address, tokenAmount, kwhWei);
  await tx2.wait();
  console.log("  ✓ Settled. Tokens transferred to provider, kWh decremented from storage.");
  console.log();

  await network.provider.request({
    method: "hardhat_stopImpersonatingAccount",
    params: [vppCloudAddr],
  });

  // AFTER
  const supply1 = await token.totalSupply();
  const tve1 = await engine.totalVerifiedEnergyInStorage();
  const fi1 = await engine.getFloatingIndex();
  console.log("AFTER consumption:");
  console.log("  Total supply:    ", ethers.formatUnits(supply1, 18), "XRGY  (unchanged — NO BURN)");
  console.log("  Energy storage:  ", ethers.formatUnits(tve1, 18), "kWh   (decreased by", kwhToConsume + ")");
  console.log("  Floating index:  ", ethers.formatUnits(fi1, 18), "kWh/token  ← DROPPED");
  console.log();
  console.log("Refresh dashboard: http://localhost:5173/  to see Floating Index move.");
  console.log("==================================================");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
