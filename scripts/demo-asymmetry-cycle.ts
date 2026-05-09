// Energy Asymmetry Cycle Demo — runs continuous charge ↔ consume sequence,
// driving the floating index up and down. Mag watches the dashboard pulse.
//
// Each iteration:
//   1. Simulator-equivalent charge event:
//      Admin records mint into Engine via direct test-hook (faster than
//      full simulator → adapter → router round-trip for demo pacing).
//      OR: drives existing simulator mint flow (real path).
//   2. Settlement consume event:
//      VPP cloud (impersonated) settles N kWh worth → TVE drops.
//
// Pacing: 4 seconds between events so Mag can watch the dashboard refresh.
//
// Usage: npx hardhat run --network localhost scripts/demo-asymmetry-cycle.ts

import fs from "fs";
import path from "path";
import { ethers, network } from "hardhat";

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const file = path.resolve(__dirname, `../deployments/${network.name}.json`);
  const book = JSON.parse(fs.readFileSync(file, "utf-8"));
  const TOKEN = book.contracts.XRGYToken;
  const SETTLEMENT = book.contracts.Settlement;
  const ENGINE = book.contracts.MintingEngine;

  const [deployer] = await ethers.getSigners();
  const token = await ethers.getContractAt("XRGYToken", TOKEN);
  const engine = await ethers.getContractAt("MintingEngine", ENGINE);
  const settlement = await ethers.getContractAt("Settlement", SETTLEMENT);

  const vppCloudPk = ethers.keccak256(
    ethers.toUtf8Bytes("exergy-sim:vpp:smoke-vpp"),
  );
  const vppCloudAddr = new ethers.Wallet(vppCloudPk).address;

  // Impersonate VPP cloud for settlement legs
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [vppCloudAddr],
  });
  await deployer.sendTransaction({ to: vppCloudAddr, value: ethers.parseEther("5") });
  const vppSigner = await ethers.getSigner(vppCloudAddr);

  // Acquire TEST_HOOK_ROLE so we can fast-mint via adminSetTotalVerifiedEnergy
  // (purely for demo pacing; real charge path uses simulator → adapter → router)
  const TEST_ROLE = await engine.TEST_HOOK_ROLE();

  console.log("=================================================");
  console.log(" Energy Asymmetry Cycle — watch dashboard pulse");
  console.log(" http://localhost:5173/");
  console.log("=================================================");
  console.log();

  async function snapshot(label: string) {
    const supply = await token.totalSupply();
    const tve = await engine.totalVerifiedEnergyInStorage();
    const fi = await engine.getFloatingIndex();
    console.log(
      `  [${label}] supply=${ethers.formatUnits(supply, 18)} XRGY | TVE=${ethers.formatUnits(tve, 18)} kWh | index=${ethers.formatUnits(fi, 18).slice(0, 6)}`,
    );
  }

  await snapshot("START");

  // We won't fast-mint via test hooks — we'll drive REAL settle cycles
  // (consume) and let Mag observe the index dropping. Then we'll restore
  // via fresh sim packets at the end (commented as next step).

  // 5 consume events of varying sizes — index will progressively drop.
  const consumeAmounts = [3, 5, 2, 4, 1];

  for (let i = 0; i < consumeAmounts.length; i++) {
    const kwh = consumeAmounts[i];
    const kwhWei = ethers.parseEther(kwh.toString());
    const tokenAmount = kwhWei;
    const approveAmount = (tokenAmount * 10025n) / 10000n;

    console.log();
    console.log(`Step ${i + 1}: consuming ${kwh} kWh...`);

    // Approve + settle
    const a = await token.connect(vppSigner).approve(SETTLEMENT, approveAmount);
    await a.wait();
    const s = await settlement
      .connect(vppSigner)
      .settleEnergy(deployer.address, tokenAmount, kwhWei);
    await s.wait();

    await snapshot(`AFTER −${kwh}kWh`);

    // 4-second pacing for dashboard refresh
    if (i < consumeAmounts.length - 1) await sleep(4000);
  }

  console.log();
  console.log("=================================================");
  console.log(" Cycle complete. To restore index back up, run new");
  console.log(" mint events via simulator (adds verified energy):");
  console.log();
  console.log("   cd oracle-simulator");
  console.log("   npx ts-node src/index.ts single-packet \\");
  console.log("     --device smoke-dev --vpp smoke-vpp \\");
  console.log("     --kwh 5 --cycles 9   # delta from last (8) = 1, valid");
  console.log("=================================================");

  await network.provider.request({
    method: "hardhat_stopImpersonatingAccount",
    params: [vppCloudAddr],
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
