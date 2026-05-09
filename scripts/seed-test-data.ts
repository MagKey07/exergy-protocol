// Seeds the testnet deployment with three mock VPPs (Texas / Berlin / Sydney),
// each with five mock devices. Output: deployments/seed-<network>.json with
// all generated wallets so the oracle simulator can replay measurements.
//
// SAFETY: testnet only. We persist private keys for the oracle simulator —
// these are throwaway wallets generated at seed time.
//
// Usage:
//   npx hardhat run --network arbitrumSepolia scripts/seed-test-data.ts

import fs from "fs";
import path from "path";
import { ethers, network } from "hardhat";

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
  privateKey: string; // for VPP cloud signer
  region: string;
  devices: SeedDevice[];
}

interface SeedBook {
  network: string;
  vpps: SeedVpp[];
  deployedAt: string;
}

const VPPS: { label: string; region: string; sources: number[] }[] = [
  { label: "Texas Solar VPP", region: "us-tx", sources: [0, 0, 0, 1, 0] }, // mostly solar, one wind
  { label: "Berlin Mixed VPP", region: "eu-de", sources: [0, 1, 1, 0, 0] }, // solar+wind
  { label: "Sydney Storage VPP", region: "au-nsw", sources: [0, 0, 0, 0, 0] }, // residential solar
];

function devicePubKeyHash(privateKey: string): string {
  // Contract truth: keccak256(abi.encodePacked(20-byte address)).
  // Earlier impl hashed uncompressed pubkey — corrected after D-1 audit.
  const wallet = new ethers.Wallet(privateKey);
  return ethers.solidityPackedKeccak256(["address"], [wallet.address]);
}

async function main() {
  const file = path.resolve(__dirname, `../deployments/${network.name}.json`);
  if (!fs.existsSync(file)) throw new Error(`No deployment at ${file}. Run deploy.ts first.`);
  const book = JSON.parse(fs.readFileSync(file, "utf-8"));

  const governance = await ethers.getContractAt(
    "ProtocolGovernance",
    book.contracts.ProtocolGovernance
  );
  const oracleRouter = await ethers.getContractAt(
    "OracleRouter",
    book.contracts.OracleRouter
  );

  const seedBook: SeedBook = {
    network: network.name,
    vpps: [],
    deployedAt: new Date().toISOString(),
  };

  for (const v of VPPS) {
    console.log(`\n=== Seeding VPP: ${v.label} ===`);
    const vppCloud = ethers.Wallet.createRandom();
    console.log(`  cloud signer: ${vppCloud.address}`);

    // Register VPP in governance.
    // Contract: registerVPP(bytes32 vppId, address operatorAddress)
    const vppId = ethers.id(v.label);
    const tx = await governance.registerVPP(vppId, vppCloud.address);
    await tx.wait();
    console.log(`  ✓ registered with governance (vppId: ${vppId.slice(0, 14)}…)`);

    const devices: SeedDevice[] = [];
    for (let i = 0; i < 5; i++) {
      const dev = ethers.Wallet.createRandom();
      const deviceId = ethers.id(`${v.label}-device-${i + 1}`);
      const pubKeyHash = devicePubKeyHash(dev.privateKey);

      const txd = await oracleRouter.registerDevice(deviceId, vppCloud.address, pubKeyHash);
      await txd.wait();
      console.log(`  ✓ device ${i + 1} registered: ${deviceId.slice(0, 14)}…`);

      devices.push({
        deviceId,
        privateKey: dev.privateKey,
        pubKeyHash,
        capacityKwh: 13_500 + i * 1000, // varies by device
        initialChargePercent: 50 + i * 5,
      });
    }

    seedBook.vpps.push({
      label: v.label,
      address: vppCloud.address,
      privateKey: vppCloud.privateKey,
      region: v.region,
      devices,
    });
  }

  const outFile = path.resolve(__dirname, `../deployments/seed-${network.name}.json`);
  fs.writeFileSync(outFile, JSON.stringify(seedBook, null, 2));
  console.log(`\nSeed book written to ${outFile}`);
  console.log(
    "Hand this file to the oracle simulator (oracle-simulator/.env: SEED_FILE=…) so it can replay signed measurements."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
