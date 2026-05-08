// Shared Hardhat fixtures for Exergy Protocol MVP tests.
//
// These fixtures use ethers v6 + Hardhat Network's loadFixture so that every
// test starts from a known-good deployed system in milliseconds.
//
// Naming convention for the system under test:
//   - XRGYToken         — ERC-20 + ERC-2612 permit, mint-only by MintingEngine
//   - MintingEngine     — halving math + floating index + epoch state
//   - OracleRouter      — dual-signature trust boundary + device registry
//   - Settlement        — P2P transfers, fees, NO BURN
//   - ProtocolGovernance — VPP register/deactivate, pause, parameters
//
// Tests are written against the SPEC in:
//   /Users/magomedkiev/Desktop/Projects_Agents_Claude/Exergy/01_Pitch/Technical_Blueprint.md
// and the interface stubs in
//   /Users/magomedkiev/Desktop/Projects_Agents_Claude/Exergy/MVP/contracts/interfaces/
//
// They will green up once the smart contracts are committed by the contracts agent.

import { ethers, upgrades } from "hardhat";
import type { Signer } from "ethers";

/** kWh -> wei helper for readable expectations. */
export const KWH = (n: number | bigint) => BigInt(n);

/** 1 token = 1e18 wei (XRGY uses 18 decimals like standard ERC-20). */
export const ONE_TOKEN = 10n ** 18n;

/** Halving threshold per spec §5: 1M tokens between eras. */
export const HALVING_THRESHOLD_TOKENS = 1_000_000n;
export const HALVING_THRESHOLD_WEI = HALVING_THRESHOLD_TOKENS * ONE_TOKEN;

/** Spec §2.2 + §3: 24h epoch boundaries. */
export const EPOCH_DURATION_SECONDS = 24n * 60n * 60n;

/** Fee bps per Technical_Blueprint.md §2.4. */
export const MINT_FEE_BPS = 100n; // 1.00%
export const SETTLEMENT_FEE_BPS = 25n; // 0.25%
export const BPS_DENOMINATOR = 10_000n;

/** Fee distribution split (sums to 100%). Spec §2.4. */
export const FEE_SPLIT = {
  treasury: 4000n, // 40%
  team: 2000n, // 20% (4y vest in production; vesting handled outside MVP)
  ecosystem: 2500n, // 25%
  insurance: 1500n, // 15%
};

export interface DeployedSystem {
  // Signers
  deployer: Signer;
  governor: Signer;
  treasury: Signer;
  team: Signer;
  ecosystem: Signer;
  insurance: Signer;
  vppA: Signer; // mock VPP operator A
  vppB: Signer; // mock VPP operator B
  alice: Signer; // end user / participant
  bob: Signer; // end user / participant
  attacker: Signer;
  deviceSigner: Signer; // device HSM-equivalent EOA
  vppCloudSigner: Signer; // VPP cloud signer EOA (registered against vppA)

  // Contracts
  token: any;
  mintingEngine: any;
  oracleRouter: any;
  settlement: any;
  governance: any;
}

/**
 * Deploys the full system in a topology compatible with the interfaces in
 * contracts/interfaces/. The contract names below are the *expected* artifact
 * names — if the contracts agent uses different names, only this fixture needs
 * to change, not individual tests.
 */
export async function deployFullSystem(): Promise<DeployedSystem> {
  const [
    deployer,
    governor,
    treasury,
    team,
    ecosystem,
    insurance,
    vppA,
    vppB,
    alice,
    bob,
    attacker,
    deviceSigner,
    vppCloudSigner,
  ] = await ethers.getSigners();

  // 1. XRGYToken — non-upgradeable per §2.1.
  const TokenFactory = await ethers.getContractFactory("XRGYToken");
  const token = await TokenFactory.deploy("Exergy", "XRGY");
  await token.waitForDeployment();

  // 2. MintingEngine — UUPS upgradeable per §2.5.
  const MintingFactory = await ethers.getContractFactory("MintingEngine");
  const mintingEngine = await upgrades.deployProxy(
    MintingFactory,
    [
      await token.getAddress(),
      await governor.getAddress(),
      // genesisTimestamp = 0 means "use block.timestamp at init"
      0,
    ],
    { kind: "uups" }
  );
  await mintingEngine.waitForDeployment();

  // 3. OracleRouter — UUPS upgradeable.
  const OracleFactory = await ethers.getContractFactory("OracleRouter");
  const oracleRouter = await upgrades.deployProxy(
    OracleFactory,
    [await governor.getAddress()],
    { kind: "uups" }
  );
  await oracleRouter.waitForDeployment();

  // 4. Settlement — UUPS upgradeable, takes fee receivers.
  const SettlementFactory = await ethers.getContractFactory("Settlement");
  const settlement = await upgrades.deployProxy(
    SettlementFactory,
    [
      await token.getAddress(),
      await mintingEngine.getAddress(),
      await governor.getAddress(),
      {
        treasury: await treasury.getAddress(),
        team: await team.getAddress(),
        ecosystem: await ecosystem.getAddress(),
        insurance: await insurance.getAddress(),
      },
    ],
    { kind: "uups" }
  );
  await settlement.waitForDeployment();

  // 5. ProtocolGovernance — UUPS upgradeable.
  const GovFactory = await ethers.getContractFactory("ProtocolGovernance");
  const governance = await upgrades.deployProxy(
    GovFactory,
    [
      await governor.getAddress(),
      await oracleRouter.getAddress(),
      await mintingEngine.getAddress(),
      await settlement.getAddress(),
    ],
    { kind: "uups" }
  );
  await governance.waitForDeployment();

  // Wire the system. One-shot setters.
  await token.connect(deployer).setMintingEngine(await mintingEngine.getAddress());
  await mintingEngine
    .connect(governor)
    .setOracleRouter(await oracleRouter.getAddress());
  await mintingEngine
    .connect(governor)
    .setSettlement(await settlement.getAddress());
  await oracleRouter
    .connect(governor)
    .setMintingEngine(await mintingEngine.getAddress());

  return {
    deployer,
    governor,
    treasury,
    team,
    ecosystem,
    insurance,
    vppA,
    vppB,
    alice,
    bob,
    attacker,
    deviceSigner,
    vppCloudSigner,
    token,
    mintingEngine,
    oracleRouter,
    settlement,
    governance,
  };
}

/**
 * Lighter fixture for token-only tests. Deploys XRGYToken and a "fake"
 * MintingEngine address (a plain EOA we control) to exercise the
 * mint-restriction without bringing the rest of the system online.
 */
export async function deployTokenOnly() {
  const [deployer, fakeEngine, alice, bob, attacker] = await ethers.getSigners();

  const TokenFactory = await ethers.getContractFactory("XRGYToken");
  const token = await TokenFactory.deploy("Exergy", "XRGY");
  await token.waitForDeployment();

  await token.connect(deployer).setMintingEngine(await fakeEngine.getAddress());

  return { deployer, fakeEngine, alice, bob, attacker, token };
}
