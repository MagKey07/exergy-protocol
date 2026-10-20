// Read-only (eth_call, nothing is written): confirm the live MintingEngine mints only for
// growth of a device's stock. Takes a device that already reported charge before the
// upgrade, simulates a recharge to its current level (expect 0 notes) and a charge
// 1 kWh above its highest level (expect 1 note at era 0).
import fs from "fs";
import path from "path";
import { ethers } from "hardhat";

async function main() {
  const c = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../deployments/arbitrumSepolia.json"), "utf-8")).contracts;
  const engine = await ethers.getContractAt("MintingEngine", c.MintingEngine);
  // Device and VPP from the dashboard snapshot (the free RPC tier refuses wide log queries).
  const deviceId = process.env.DEVICE as string;
  const vpp = process.env.VPP as string;
  if (!deviceId || !vpp) throw new Error("set DEVICE and VPP");
  const st = await engine.getDeviceCycleState(deviceId);
  const held = st.lastReportedEnergy as bigint;
  const cap = st.storageCapacity as bigint;
  const max = await engine.deviceMaxHeld(deviceId);
  console.log("device", deviceId.slice(0, 12), "capacity", ethers.formatEther(cap), "kWh, holds", ethers.formatEther(held), "kWh, high mark", ethers.formatEther(max), "kWh");
  const cycles = Number(st.lastCumulativeCycles) + 1;
  const sim = async (kwh: bigint, pct: number) => {
    const data = engine.interface.encodeFunctionData("commitVerifiedEnergy", [deviceId, vpp, kwh, cycles, cap, pct]);
    const ret = await ethers.provider.call({ to: c.MintingEngine, from: c.OracleRouter, data });
    return engine.interface.decodeFunctionResult("commitVerifiedEnergy", ret)[0] as bigint;
  };
  const pctOf = (e: bigint) => Number((e * 100n) / cap);
  const atMax = pctOf(max);
  console.log(`recharge to ${atMax}% (≤ high mark) with 5 kWh new energy → notes:`, ethers.formatEther(await sim(ethers.parseEther("5"), atMax)));
  if (atMax < 100) {
    const above = Math.min(100, atMax + 1);
    const growth = (cap * BigInt(above)) / 100n - max;
    console.log(`charge to ${above}% (growth ${ethers.formatEther(growth)} kWh) with 5 kWh new energy → notes:`, ethers.formatEther(await sim(ethers.parseEther("5"), above)), "(era", (await engine.currentEra()).toString() + ")");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
