// Admin script: register a new VPP as an approved operator.
//
// Usage:
//   VPP_ADDRESS=0xabc... VPP_LABEL="Berlin Solar Co" \
//     npx hardhat run --network arbitrumSepolia scripts/register-vpp.ts
//
// Reads ProtocolGovernance address from deployments/<network>.json.

import fs from "fs";
import path from "path";
import { ethers, network } from "hardhat";

async function main() {
  const vppAddress = process.env.VPP_ADDRESS;
  const vppLabel = process.env.VPP_LABEL || "Unnamed VPP";
  if (!vppAddress) throw new Error("Set VPP_ADDRESS env var");
  if (!ethers.isAddress(vppAddress)) throw new Error(`Bad address: ${vppAddress}`);

  const file = path.resolve(__dirname, `../deployments/${network.name}.json`);
  if (!fs.existsSync(file)) throw new Error(`No deployment at ${file}`);
  const book = JSON.parse(fs.readFileSync(file, "utf-8"));

  const governance = await ethers.getContractAt(
    "ProtocolGovernance",
    book.contracts.ProtocolGovernance
  );

  const metadataHash = ethers.id(vppLabel);
  console.log(`Registering ${vppLabel} (${vppAddress})`);
  console.log(`  metadataHash: ${metadataHash}`);

  const tx = await governance.registerVPP(vppAddress, metadataHash);
  console.log(`  tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  ✓ confirmed in block ${receipt?.blockNumber}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
