// Verifies all deployed contracts on Arbiscan / Etherscan using the
// hardhat-verify plugin. Reads addresses from deployments/<network>.json.
//
// Usage:
//   npx hardhat run --network arbitrumSepolia scripts/verify.ts

import fs from "fs";
import path from "path";
import { network, run } from "hardhat";

interface AddressBook {
  contracts: {
    XRGYToken: string;
    MintingEngine: string;
    OracleRouter: string;
    Settlement: string;
    ProtocolGovernance: string;
  };
  implementations: Record<string, string>;
  feeReceivers: {
    treasury: string;
    team: string;
    ecosystem: string;
    insurance: string;
  };
}

async function safeVerify(label: string, address: string, args: any[] = []) {
  try {
    console.log(`Verifying ${label} @ ${address}...`);
    await run("verify:verify", { address, constructorArguments: args });
    console.log(`  ✓ ${label} verified`);
  } catch (e: any) {
    if (String(e?.message || "").includes("Already Verified")) {
      console.log(`  • ${label} already verified`);
    } else {
      console.warn(`  ! ${label} failed:`, e?.message || e);
    }
  }
}

async function main() {
  const file = path.resolve(__dirname, `../deployments/${network.name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`No deployment found at ${file}. Run deploy.ts first.`);
  }
  const book: AddressBook = JSON.parse(fs.readFileSync(file, "utf-8"));

  // 1. XRGYToken — non-proxy, has constructor("Exergy","XRGY")
  await safeVerify("XRGYToken", book.contracts.XRGYToken, ["Exergy", "XRGY"]);

  // 2-5. UUPS proxies — verify the implementation contracts.
  // Etherscan shows the proxy linked to the impl after this.
  for (const name of ["MintingEngine", "OracleRouter", "Settlement", "ProtocolGovernance"] as const) {
    const impl = book.implementations[name];
    if (!impl || impl === "<unknown>") {
      console.warn(`  ! Skipping ${name} — implementation address unknown`);
      continue;
    }
    await safeVerify(`${name} (impl)`, impl, []);
  }

  console.log("All verifications attempted.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
