// UUPS upgrade for any of the four upgradeable contracts.
// XRGYToken is intentionally NOT upgradeable (spec §2.1) — this script
// will refuse to "upgrade" it.
//
// Usage:
//   CONTRACT=MintingEngine NEW_VERSION=MintingEngineV2 \
//     npx hardhat run --network arbitrumSepolia scripts/upgrade.ts

import fs from "fs";
import path from "path";
import { ethers, network, upgrades } from "hardhat";

const UPGRADEABLE = new Set([
  "MintingEngine",
  "OracleRouter",
  "Settlement",
  "ProtocolGovernance",
]);

async function main() {
  const contractName = process.env.CONTRACT;
  const newImpl = process.env.NEW_VERSION || contractName;
  if (!contractName) throw new Error("Set CONTRACT env var");
  if (contractName === "XRGYToken") {
    throw new Error("XRGYToken is NOT upgradeable by design (spec §2.1)");
  }
  if (!UPGRADEABLE.has(contractName)) {
    throw new Error(`Unknown upgradeable contract: ${contractName}`);
  }

  const file = path.resolve(__dirname, `../deployments/${network.name}.json`);
  if (!fs.existsSync(file)) throw new Error(`No deployment at ${file}`);
  const book = JSON.parse(fs.readFileSync(file, "utf-8"));

  const proxyAddr = book.contracts[contractName];
  if (!proxyAddr) throw new Error(`No deployed proxy for ${contractName}`);

  console.log(`Upgrading ${contractName}@${proxyAddr} → impl ${newImpl}`);
  const Factory = await ethers.getContractFactory(newImpl);
  const upgraded = await upgrades.upgradeProxy(proxyAddr, Factory);
  await upgraded.waitForDeployment();

  const newImplAddress = await upgrades.erc1967.getImplementationAddress(proxyAddr);
  console.log(`  ✓ upgraded. New implementation: ${newImplAddress}`);

  // Patch the address book.
  book.implementations[contractName] = newImplAddress;
  book.lastUpgradeAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(book, null, 2));
  fs.writeFileSync(
    path.resolve(__dirname, `../deployments/latest.json`),
    JSON.stringify(book, null, 2)
  );
  console.log(`  address book patched at ${file}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
