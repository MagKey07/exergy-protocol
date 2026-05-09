// Deploys the full Exergy Protocol MVP system in the correct topological order
// and persists all addresses to deployments/<network>.json so the dashboard,
// oracle simulator, and verification script can pick them up automatically.
//
// Order matters:
//   1. XRGYToken                (no dependencies)
//   2. MintingEngine            (knows token)
//   3. OracleRouter             (knows nothing yet — set MintingEngine after)
//   4. Settlement               (knows token + MintingEngine)
//   5. ProtocolGovernance       (knows the other three)
//   6. Wire one-shot setters in this exact sequence:
//      - token.setMintingEngine(mintingEngine)
//      - mintingEngine.setOracleRouter(oracleRouter)
//      - mintingEngine.setSettlement(settlement)
//      - oracleRouter.setMintingEngine(mintingEngine)
//
// Usage:
//   npx hardhat run --network arbitrumSepolia scripts/deploy.ts
//
// Output: console table + deployments/<network>.json with full address book.

import fs from "fs";
import path from "path";
import { ethers, network, upgrades } from "hardhat";

interface AddressBook {
  network: string;
  chainId: number;
  deployer: string;
  governor: string;
  feeReceivers: {
    treasury: string;
    team: string;
    ecosystem: string;
    insurance: string;
  };
  contracts: {
    XRGYToken: string;
    MintingEngine: string;
    OracleRouter: string;
    Settlement: string;
    ProtocolGovernance: string;
  };
  implementations: Record<string, string>;
  deployedAt: string;
  blockNumber: number;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);

  console.log("==============================================");
  console.log(" Exergy Protocol — MVP Deployment");
  console.log("==============================================");
  console.log("Network: ", network.name, "(chainId", chainId + ")");
  console.log("Deployer:", deployer.address);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance: ", ethers.formatEther(balance), "ETH");
  console.log("----------------------------------------------");

  // ---------- Resolve env-driven actor addresses --------------------------
  // For testnet demos, default these to the deployer if not set.
  const governor = process.env.GOVERNOR_ADDRESS || deployer.address;
  const treasury = process.env.TREASURY_ADDRESS || deployer.address;
  const team = process.env.TEAM_ADDRESS || deployer.address;
  const ecosystem = process.env.ECOSYSTEM_ADDRESS || deployer.address;
  const insurance = process.env.INSURANCE_ADDRESS || deployer.address;

  // ---------- 1. XRGYToken (non-upgradeable) ------------------------------
  console.log("[1/5] Deploying XRGYToken...");
  const TokenFactory = await ethers.getContractFactory("XRGYToken");
  const token = await TokenFactory.deploy("Exergy", "XRGY", deployer.address);
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();
  console.log("      XRGYToken @", tokenAddr);

  // ---------- 2. MintingEngine (UUPS proxy) ------------------------------
  console.log("[2/5] Deploying MintingEngine (UUPS)...");
  const MintingFactory = await ethers.getContractFactory("MintingEngine");
  const mintingEngine = await upgrades.deployProxy(
    MintingFactory,
    [tokenAddr, governor, ethers.parseEther("1000000")],
    { kind: "uups" }
  );
  await mintingEngine.waitForDeployment();
  const mintingAddr = await mintingEngine.getAddress();
  console.log("      MintingEngine @", mintingAddr);

  // ---------- 3. OracleRouter (UUPS proxy) -------------------------------
  console.log("[3/5] Deploying OracleRouter (UUPS)...");
  const OracleFactory = await ethers.getContractFactory("OracleRouter");
  const oracleRouter = await upgrades.deployProxy(
    OracleFactory,
    [governor],
    { kind: "uups" }
  );
  await oracleRouter.waitForDeployment();
  const oracleAddr = await oracleRouter.getAddress();
  console.log("      OracleRouter @", oracleAddr);

  // ---------- 4. Settlement (UUPS proxy) ---------------------------------
  console.log("[4/5] Deploying Settlement (UUPS)...");
  const SettlementFactory = await ethers.getContractFactory("Settlement");
  const settlement = await upgrades.deployProxy(
    SettlementFactory,
    [
      governor,
      tokenAddr,
      mintingAddr,
      { treasury, team, ecosystem, insurance },
    ],
    { kind: "uups" }
  );
  await settlement.waitForDeployment();
  const settlementAddr = await settlement.getAddress();
  console.log("      Settlement @", settlementAddr);

  // ---------- 5. ProtocolGovernance (UUPS proxy) -------------------------
  console.log("[5/5] Deploying ProtocolGovernance (UUPS)...");
  const GovFactory = await ethers.getContractFactory("ProtocolGovernance");
  const governance = await upgrades.deployProxy(
    GovFactory,
    [governor],
    { kind: "uups" }
  );
  await governance.waitForDeployment();
  const governanceAddr = await governance.getAddress();
  console.log("      ProtocolGovernance @", governanceAddr);

  // ---------- Wire one-shot setters --------------------------------------
  console.log("Wiring one-shot setters...");
  const tx1 = await token.setMintingEngine(mintingAddr);
  await tx1.wait();
  console.log("      token.setMintingEngine ✓");

  const tx2 = await mintingEngine.setOracleRouter(oracleAddr);
  await tx2.wait();
  console.log("      mintingEngine.setOracleRouter ✓");

  const tx3 = await mintingEngine.setSettlement(settlementAddr);
  await tx3.wait();
  console.log("      mintingEngine.setSettlement ✓");

  const tx4 = await oracleRouter.setMintingEngine(mintingAddr);
  await tx4.wait();
  console.log("      oracleRouter.setMintingEngine ✓");

  // ---------- Resolve implementation addresses for verification ----------
  const impls: Record<string, string> = {};
  for (const [name, proxy] of [
    ["MintingEngine", mintingAddr],
    ["OracleRouter", oracleAddr],
    ["Settlement", settlementAddr],
    ["ProtocolGovernance", governanceAddr],
  ] as const) {
    try {
      impls[name] = await upgrades.erc1967.getImplementationAddress(proxy);
    } catch (e) {
      impls[name] = "<unknown>";
    }
  }

  // ---------- Persist address book ---------------------------------------
  const blockNumber = await ethers.provider.getBlockNumber();
  const book: AddressBook = {
    network: network.name,
    chainId,
    deployer: deployer.address,
    governor,
    feeReceivers: { treasury, team, ecosystem, insurance },
    contracts: {
      XRGYToken: tokenAddr,
      MintingEngine: mintingAddr,
      OracleRouter: oracleAddr,
      Settlement: settlementAddr,
      ProtocolGovernance: governanceAddr,
    },
    implementations: impls,
    deployedAt: new Date().toISOString(),
    blockNumber,
  };

  const outDir = path.resolve(__dirname, "../deployments");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${network.name}.json`);
  fs.writeFileSync(outFile, JSON.stringify(book, null, 2));

  // Also write a "latest" pointer so dashboard config stays stable.
  fs.writeFileSync(path.join(outDir, "latest.json"), JSON.stringify(book, null, 2));

  console.log("----------------------------------------------");
  console.log("Deployment complete. Address book written to:");
  console.log("  ", outFile);
  console.log("==============================================");
  console.log(JSON.stringify(book, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
