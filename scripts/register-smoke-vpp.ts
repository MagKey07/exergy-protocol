// One-off smoke test setup: register a VPP that matches the oracle simulator's
// deterministic "vpp:smoke-vpp" identity. Run after deploy.ts on localhost.
//
// Usage: npx hardhat run --network localhost scripts/register-smoke-vpp.ts

import fs from "fs";
import path from "path";
import { ethers, network } from "hardhat";

async function main() {
  const file = path.resolve(__dirname, `../deployments/${network.name}.json`);
  if (!fs.existsSync(file)) throw new Error(`No deployment at ${file}`);
  const book = JSON.parse(fs.readFileSync(file, "utf-8"));

  // Mirror simulator's fromSeed: keccak256(utf8("exergy-sim:" + label))
  const seedLabel = "vpp:smoke-vpp";
  const digest = ethers.keccak256(ethers.toUtf8Bytes(`exergy-sim:${seedLabel}`));
  const vppCloudWallet = new ethers.Wallet(digest);
  const vppCloudAddress = vppCloudWallet.address;
  const vppId = ethers.id(seedLabel);

  console.log("Smoke VPP cloud signer:", vppCloudAddress);
  console.log("Smoke VPP id (bytes32):", vppId);

  const governance = await ethers.getContractAt(
    "ProtocolGovernance",
    book.contracts.ProtocolGovernance
  );

  const tx = await governance.registerVPP(vppId, vppCloudAddress);
  await tx.wait();
  console.log("✓ VPP registered at ProtocolGovernance");

  console.log("\nNext: simulator can now register devices under this VPP via");
  console.log("  npx ts-node src/index.ts register-device --device smoke-dev --vpp smoke-vpp");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
