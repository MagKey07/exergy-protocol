// One-time migration step for the pool-accounting upgrade.
//
// Before the upgrade `totalVerifiedEnergyInStorage` was a running tally (mints minus
// settlements). After it, the pool is the sum of what devices currently report holding,
// tracked per device. Entries written before the upgrade carry no per-device figure, so
// the legacy tally and the new per-device sum sit on top of each other until this runs.
//
// This sets the pool to the true sum of live device reports. Run AFTER every device has
// reported at least once (scripts/push-fleet-measurements.ts).
//
// Usage:
//   TARGET_KWH=121.5 npx hardhat run --network arbitrumSepolia scripts/resync-pool.ts

import fs from "fs";
import path from "path";
import { ethers, network } from "hardhat";

async function main() {
  const target = process.env.TARGET_KWH;
  if (!target) throw new Error("Set TARGET_KWH (e.g. TARGET_KWH=121.5)");
  const targetWei = ethers.parseUnits(target, 18);

  const book = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, `../deployments/${network.name}.json`), "utf-8")
  );
  const engine = await ethers.getContractAt("MintingEngine", book.contracts.MintingEngine);
  const [signer] = await ethers.getSigners();

  const before = await engine.totalVerifiedEnergyInStorage();
  console.log(`pool before : ${ethers.formatUnits(before, 18)} kWh`);
  console.log(`pool target : ${target} kWh`);
  console.log(`difference  : ${ethers.formatUnits(before - targetWei, 18)} kWh (legacy tally)`);

  const role = await engine.TEST_HOOK_ROLE();
  if (!(await engine.hasRole(role, signer.address))) {
    console.log(`granting TEST_HOOK_ROLE to ${signer.address}…`);
    await (await engine.grantRole(role, signer.address)).wait();
  }

  await (await engine.adminSetTotalVerifiedEnergy(targetWei)).wait();

  const after = await engine.totalVerifiedEnergyInStorage();
  const supply = await engine.totalTokensMinted();
  const index = await engine.getFloatingIndex();

  console.log(`\npool after   : ${ethers.formatUnits(after, 18)} kWh`);
  console.log(`total minted : ${ethers.formatUnits(supply, 18)} XRGY`);
  console.log(`floating idx : ${ethers.formatUnits(index, 18)} kWh per note`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
