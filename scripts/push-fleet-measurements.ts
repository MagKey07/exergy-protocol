// Push one dual-signed measurement per seeded device.
//
// Purpose: rebuild `totalVerifiedEnergyInStorage` from what devices actually report
// holding, after the pool-accounting upgrade (docs/TECH_DEBT_pool_accounting.md).
// The pool is now the sum of capacity × state-of-charge across reporting devices, so
// it only becomes meaningful once every device has spoken at least once.
//
// Reads deployments/seed-<network>.json (written by seed-test-data.ts).
//
// Usage:
//   npx hardhat run --network arbitrumSepolia scripts/push-fleet-measurements.ts

import fs from "fs";
import path from "path";
import { ethers, network } from "hardhat";

const WAD = 10n ** 18n;

/** Realistic home-battery capacity in 18-decimal kWh. */
const CAPACITY_KWH = (13n * WAD) + (WAD / 2n); // 13.5 kWh

interface SeedDevice {
  deviceId: string;
  privateKey: string;
  pubKeyHash: string;
  capacityKwh: number;
  initialChargePercent: number;
}
interface SeedVpp {
  label: string;
  address: string;
  privateKey: string;
  region: string;
  devices: SeedDevice[];
}

const PACKET_TYPE =
  "tuple(bytes32 deviceId,uint256 kwhAmount,uint64 timestamp,uint256 storageCapacity,uint8 chargeLevelPercent,uint8 sourceType,uint32 cumulativeCycles)";

function hashPacket(p: any): string {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(
    coder.encode(
      [PACKET_TYPE],
      [
        [
          p.deviceId,
          p.kwhAmount,
          p.timestamp,
          p.storageCapacity,
          p.chargeLevelPercent,
          p.sourceType,
          p.cumulativeCycles,
        ],
      ]
    )
  );
}

async function main() {
  const bookFile = path.resolve(__dirname, `../deployments/${network.name}.json`);
  const seedFile = path.resolve(__dirname, `../deployments/seed-${network.name}.json`);
  if (!fs.existsSync(seedFile)) throw new Error(`No seed book at ${seedFile}. Run seed-test-data.ts first.`);

  const book = JSON.parse(fs.readFileSync(bookFile, "utf-8"));
  const seed = JSON.parse(fs.readFileSync(seedFile, "utf-8")) as { vpps: SeedVpp[] };

  const router = await ethers.getContractAt("OracleRouter", book.contracts.OracleRouter);
  const engine = await ethers.getContractAt("MintingEngine", book.contracts.MintingEngine);

  console.log(`Pool before: ${ethers.formatUnits(await engine.totalVerifiedEnergyInStorage(), 18)} kWh`);

  let ok = 0;
  let failed = 0;
  let expectedPool = 0n;

  for (const vpp of seed.vpps) {
    const cloud = new ethers.Wallet(vpp.privateKey);
    console.log(`\n=== ${vpp.label} (${vpp.region}) ===`);

    for (const dev of vpp.devices) {
      const device = new ethers.Wallet(dev.privateKey);
      const charge = dev.initialChargePercent; // 50…70 across the fleet

      // First packet for a device: the engine checks kwhAmount <= capacity * cumulativeCycles.
      // One cycle of headroom is plenty for a single honest reading.
      const packet = {
        deviceId: dev.deviceId,
        kwhAmount: (CAPACITY_KWH * BigInt(charge)) / 100n,
        timestamp: Math.floor(Date.now() / 1000),
        storageCapacity: CAPACITY_KWH,
        chargeLevelPercent: charge,
        sourceType: 0,
        cumulativeCycles: 1,
      };

      const pHash = hashPacket(packet);
      const deviceSignature = await device.signMessage(ethers.getBytes(pHash));
      const vppInner = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes"], [pHash, deviceSignature])
      );
      const vppSignature = await cloud.signMessage(ethers.getBytes(vppInner));

      try {
        const tx = await router.submitMeasurement(packet, deviceSignature, vppSignature);
        await tx.wait();
        const held = (CAPACITY_KWH * BigInt(charge)) / 100n;
        expectedPool += held;
        ok += 1;
        console.log(
          `  ✓ ${dev.deviceId.slice(0, 12)}… charge ${charge}% → holds ${ethers.formatUnits(held, 18)} kWh`
        );
      } catch (e: any) {
        failed += 1;
        console.log(`  ✗ ${dev.deviceId.slice(0, 12)}… ${e.shortMessage ?? e.message}`);
      }
    }
  }

  const pool = await engine.totalVerifiedEnergyInStorage();
  const supply = await engine.totalTokensMinted();
  const index = await engine.getFloatingIndex();

  console.log(`\n=========================================`);
  console.log(`  submitted ok: ${ok}   failed: ${failed}`);
  console.log(`  pool expected: ${ethers.formatUnits(expectedPool, 18)} kWh`);
  console.log(`  pool actual:   ${ethers.formatUnits(pool, 18)} kWh`);
  console.log(`  total minted:  ${ethers.formatUnits(supply, 18)} XRGY`);
  console.log(`  floating index:${ethers.formatUnits(index, 18)} kWh per note`);
  console.log(`=========================================`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
