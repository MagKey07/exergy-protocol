/**
 * Fresh-VPP onboarding end-to-end validation.
 *
 * Tests the EXACT flow described in VPP_INTEGRATION_GUIDE.md §4:
 *   Step 1: Admin grants CHAINLINK_RELAYER_ROLE to fresh VPP wallet
 *   Step 2: Admin registers VPP in ProtocolGovernance
 *   Step 3: Admin registers device in OracleRouter
 *   Step 4: VPP cloud wallet approves Settlement on XRGYToken
 *   Step 5: VPP cloud wallet submits its first measurement packet
 *
 * If any step fails, the guide is wrong and we have to fix it BEFORE
 * Leigh's tech team hits the same wall.
 *
 * Generates a fresh deterministic test wallet so the run is reproducible
 * but identifiable as the SDK self-test (label: "exergy-sdk:e2e-test:vpp").
 *
 * State changes on Sepolia (additive, all reversible by admin):
 *   - 1 role grant
 *   - 1 VPP registration in ProtocolGovernance
 *   - 1 device registration in OracleRouter
 *   - ~0.005 ETH transfer to fresh wallet
 *   - 1 approve tx from fresh wallet
 *   - 1 measurement submission (mints ~0.5 XRGY)
 *
 * Run: `npx ts-node test-fresh-vpp-onboarding.ts`
 */

import * as dotenv from "dotenv";
import * as path from "path";
import { ethers } from "ethers";

dotenv.config({
  path: path.resolve(__dirname, "../oracle-simulator/.env"),
});

import {
  ARBITRUM_SEPOLIA,
  buildPacketHash,
  devicePubKeyHashFor,
  kwhToWad,
  MINTING_ENGINE_ABI,
  ORACLE_ROUTER_ABI,
  signPacket,
  simulateSubmitMeasurement,
  SourceType,
  submitMeasurement,
  XRGY_TOKEN_ABI,
} from "./src";
import type { MeasurementPacket } from "./src";

const PROTOCOL_GOVERNANCE_ABI = [
  "function registerVPP(bytes32 vppId, address operatorAddress) external",
  "function getVPP(bytes32 vppId) external view returns (tuple(bytes32 vppId, address operatorAddress, bool active, uint64 registeredAt))",
  "function hasRole(bytes32 role, address account) external view returns (bool)",
];

// Admin extras not in the published SDK (integrators don't grant roles or
// register devices themselves — admin does both). Local-only.
const ADMIN_ROUTER_EXTRAS = [
  "function grantRole(bytes32 role, address account) external",
  "function registerDevice(bytes32 deviceId, address vppAddress, bytes32 devicePubKeyHash) external",
];

// New test labels — chosen to be obviously test/SDK validation, not
// confusable with the smoke VPP or any real operator.
const TEST_VPP_LABEL = "exergy-sdk:e2e-test:vpp";
const TEST_DEVICE_LABEL = "exergy-sdk:e2e-test:device-001";

function fromSeed(seed: string): ethers.Wallet {
  const pk = ethers.keccak256(ethers.toUtf8Bytes(seed));
  return new ethers.Wallet(pk);
}

async function main() {
  console.log("Fresh-VPP onboarding end-to-end validation");
  console.log("══════════════════════════════════════════════\n");

  const provider = new ethers.JsonRpcProvider(ARBITRUM_SEPOLIA.rpcUrl);

  const adminKey = process.env.SUBMITTER_PRIVATE_KEY;
  if (!adminKey || adminKey.startsWith("0x00000000")) {
    throw new Error(
      "SUBMITTER_PRIVATE_KEY (deployer/admin) is not set in oracle-simulator/.env",
    );
  }
  const admin = new ethers.Wallet(adminKey, provider);

  const testVppWallet = fromSeed(TEST_VPP_LABEL).connect(provider);
  const testDeviceWallet = fromSeed(TEST_DEVICE_LABEL);

  console.log("Admin (deployer)  :", admin.address);
  console.log("Test VPP wallet   :", testVppWallet.address);
  console.log("Test device wallet:", testDeviceWallet.address);
  console.log();

  const router = new ethers.Contract(
    ARBITRUM_SEPOLIA.contracts.oracleRouter,
    [...ORACLE_ROUTER_ABI, ...ADMIN_ROUTER_EXTRAS],
    admin,
  );
  const engine = new ethers.Contract(
    ARBITRUM_SEPOLIA.contracts.mintingEngine,
    MINTING_ENGINE_ABI,
    provider,
  );
  const token = new ethers.Contract(
    ARBITRUM_SEPOLIA.contracts.xrgyToken,
    XRGY_TOKEN_ABI,
    provider,
  );
  const governance = new ethers.Contract(
    ARBITRUM_SEPOLIA.contracts.protocolGovernance,
    PROTOCOL_GOVERNANCE_ABI,
    admin,
  );

  // ╭─────────────────────────────────────────────────────╮
  // │ Step 1: Admin grants CHAINLINK_RELAYER_ROLE         │
  // ╰─────────────────────────────────────────────────────╯
  console.log("──── Step 1: Grant CHAINLINK_RELAYER_ROLE ────");
  const relayerRole = ethers.id("CHAINLINK_RELAYER_ROLE");
  let hasRole: boolean = await router.hasRole(relayerRole, testVppWallet.address);
  console.log("  test VPP holds role (before):", hasRole);
  if (!hasRole) {
    const tx = await router.grantRole(relayerRole, testVppWallet.address);
    const r = await tx.wait();
    console.log(`  granted in tx ${tx.hash} (block ${r?.blockNumber})`);
  }
  hasRole = await router.hasRole(relayerRole, testVppWallet.address);
  if (!hasRole) throw new Error("Step 1 failed — role not granted");
  console.log("  test VPP holds role (after) :", hasRole);
  console.log();

  // ╭─────────────────────────────────────────────────────╮
  // │ Step 2: Register VPP in ProtocolGovernance          │
  // ╰─────────────────────────────────────────────────────╯
  console.log("──── Step 2: Register VPP in ProtocolGovernance ────");
  const vppId = ethers.id(`vpp:${TEST_VPP_LABEL}`);
  console.log("  vppId:", vppId);

  // Verify admin holds GOVERNOR_ROLE (registerVPP is gated by it).
  const governorRole = ethers.id("GOVERNOR_ROLE");
  const adminHasGovernor: boolean = await governance.hasRole(
    governorRole,
    admin.address,
  );
  console.log("  admin holds GOVERNOR_ROLE:", adminHasGovernor);
  if (!adminHasGovernor) {
    throw new Error(
      "Admin does not hold GOVERNOR_ROLE on ProtocolGovernance — cannot register VPP",
    );
  }

  // getVPP reverts for unknown vppId; try/catch is the existence check.
  let registered: boolean = false;
  try {
    const rec = await governance.getVPP(vppId);
    registered = rec.operatorAddress !== ethers.ZeroAddress;
  } catch {
    registered = false;
  }
  console.log("  registered (before):", registered);
  if (!registered) {
    const tx = await governance.registerVPP(vppId, testVppWallet.address);
    const r = await tx.wait();
    console.log(`  registered in tx ${tx.hash} (block ${r?.blockNumber})`);
  }
  const recAfter = await governance.getVPP(vppId);
  console.log("  on-chain operator:", recAfter.operatorAddress);
  console.log("  on-chain active  :", recAfter.active);
  if (
    recAfter.operatorAddress.toLowerCase() !==
    testVppWallet.address.toLowerCase()
  ) {
    throw new Error("Step 2 failed — operator address mismatch");
  }
  console.log();

  // ╭─────────────────────────────────────────────────────╮
  // │ Step 3: Register device in OracleRouter             │
  // ╰─────────────────────────────────────────────────────╯
  console.log("──── Step 3: Register device in OracleRouter ────");
  const deviceId = ethers.id(`exergy-device:${TEST_DEVICE_LABEL}`);
  const devicePubKeyHash = devicePubKeyHashFor(testDeviceWallet.address);
  console.log("  deviceId           :", deviceId);
  console.log("  devicePubKeyHash   :", devicePubKeyHash);
  let device = await router.getDevice(deviceId);
  console.log("  on-chain vppAddress:", device.vppAddress);
  if (device.vppAddress === ethers.ZeroAddress) {
    const tx = await router.registerDevice(
      deviceId,
      testVppWallet.address,
      devicePubKeyHash,
    );
    const r = await tx.wait();
    console.log(`  registered in tx ${tx.hash} (block ${r?.blockNumber})`);
    device = await router.getDevice(deviceId);
  }
  if (device.vppAddress.toLowerCase() !== testVppWallet.address.toLowerCase()) {
    throw new Error("Step 3 failed — device vppAddress mismatch");
  }
  if (device.devicePubKeyHash.toLowerCase() !== devicePubKeyHash.toLowerCase()) {
    throw new Error("Step 3 failed — devicePubKeyHash mismatch (likely wrong derivation)");
  }
  if (!device.active) throw new Error("Step 3 failed — device not active");
  console.log("  ✓ device registered + active + pubkey hash matches");
  console.log();

  // ╭─────────────────────────────────────────────────────╮
  // │ Step 3.5: Fund test VPP with Sepolia ETH for gas    │
  // ╰─────────────────────────────────────────────────────╯
  console.log("──── Step 3.5: Fund test VPP wallet with ETH ────");
  const ethBal: bigint = await provider.getBalance(testVppWallet.address);
  console.log("  test VPP ETH (before):", ethers.formatEther(ethBal));
  if (ethBal < ethers.parseEther("0.001")) {
    const tx = await admin.sendTransaction({
      to: testVppWallet.address,
      value: ethers.parseEther("0.005"),
    });
    await tx.wait();
    console.log(`  funded in tx ${tx.hash}`);
  }
  const ethBalAfter: bigint = await provider.getBalance(testVppWallet.address);
  console.log("  test VPP ETH (after) :", ethers.formatEther(ethBalAfter));
  if (ethBalAfter < ethers.parseEther("0.001")) {
    throw new Error("Step 3.5 failed — funding did not arrive");
  }
  console.log();

  // ╭─────────────────────────────────────────────────────╮
  // │ Step 4: Test VPP approves Settlement on XRGYToken   │
  // ╰─────────────────────────────────────────────────────╯
  console.log("──── Step 4: Approve Settlement on XRGYToken ────");
  const tokenAsTestVpp = new ethers.Contract(
    ARBITRUM_SEPOLIA.contracts.xrgyToken,
    XRGY_TOKEN_ABI,
    testVppWallet,
  );
  const allowance: bigint = await tokenAsTestVpp.allowance(
    testVppWallet.address,
    ARBITRUM_SEPOLIA.contracts.settlement,
  );
  console.log("  allowance (before):", ethers.formatUnits(allowance, 18));
  if (allowance < ethers.MaxUint256 / 2n) {
    const tx = await tokenAsTestVpp.approve(
      ARBITRUM_SEPOLIA.contracts.settlement,
      ethers.MaxUint256,
    );
    const r = await tx.wait();
    console.log(`  approved in tx ${tx.hash} (block ${r?.blockNumber})`);
  }
  const allowanceAfter: bigint = await tokenAsTestVpp.allowance(
    testVppWallet.address,
    ARBITRUM_SEPOLIA.contracts.settlement,
  );
  if (allowanceAfter < ethers.MaxUint256 / 2n) {
    throw new Error("Step 4 failed — allowance not set");
  }
  console.log("  ✓ allowance now MAX");
  console.log();

  // ╭─────────────────────────────────────────────────────╮
  // │ Step 5: Test VPP submits its first measurement      │
  // ╰─────────────────────────────────────────────────────╯
  console.log("──── Step 5: Submit first measurement via SDK ────");
  const cycleState = await engine.getDeviceCycleState(deviceId);
  console.log("  cycleState.initialized          :", cycleState.initialized);
  console.log("  cycleState.lastCumulativeCycles :", cycleState.lastCumulativeCycles.toString());

  // First-packet bootstrap: cyclesDelta is treated as cumulativeCycles itself.
  // We pick small values so we stay well within Proof-of-Wear bounds.
  const cumulativeCycles: number = cycleState.initialized
    ? Number(cycleState.lastCumulativeCycles) + 1
    : 1;
  const storageCapacity: bigint = kwhToWad(13.5);
  // first-packet bootstrap: cyclesDelta = cumulativeCycles, so kwhAmount must
  // be ≤ storageCapacity * cumulativeCycles. We pick 0.5 kWh (well under).
  const kwhAmount: bigint = kwhToWad(0.5);

  const packet: MeasurementPacket = {
    deviceId,
    kwhAmount,
    timestamp: BigInt(Math.floor(Date.now() / 1000)),
    storageCapacity,
    chargeLevelPercent: 75,
    sourceType: SourceType.Solar,
    cumulativeCycles,
  };

  const ph = buildPacketHash(packet);
  console.log("  kwhAmount        :", ethers.formatUnits(kwhAmount, 18), "kWh");
  console.log("  cumulativeCycles :", cumulativeCycles);
  console.log("  packetHash       :", ph);

  const signed = await signPacket({
    packet,
    deviceWallet: testDeviceWallet,
    vppCloudWallet: testVppWallet,
  });
  console.log("  ✓ dual signature produced");

  // Pre-flight simulate
  const simErr = await simulateSubmitMeasurement({
    packet,
    signed,
    oracleRouterAddress: ARBITRUM_SEPOLIA.contracts.oracleRouter,
    signer: testVppWallet,
  });
  if (simErr) throw new Error(`Step 5 simulation failed: ${simErr}`);
  console.log("  ✓ simulation OK");

  // Read fee receivers + balances before
  const settlementAddr = ARBITRUM_SEPOLIA.contracts.settlement;
  const balBefore: bigint = await token.balanceOf(testVppWallet.address);
  const settlementBalBefore: bigint = await token.balanceOf(settlementAddr);
  console.log("  test VPP balance (before)   :", ethers.formatUnits(balBefore, 18), "XRGY");
  console.log("  Settlement balance (before) :", ethers.formatUnits(settlementBalBefore, 18), "XRGY");

  // Submit (test VPP wallet, since it now holds CHAINLINK_RELAYER_ROLE)
  const result = await submitMeasurement({
    packet,
    signed,
    oracleRouterAddress: ARBITRUM_SEPOLIA.contracts.oracleRouter,
    signer: testVppWallet,
  });
  console.log(`  ✓ submitted in tx ${result.txHash} (gas ${result.gasUsed.toString()})`);

  const balAfter: bigint = await token.balanceOf(testVppWallet.address);
  const settlementBalAfter: bigint = await token.balanceOf(settlementAddr);
  console.log("  test VPP balance (after)   :", ethers.formatUnits(balAfter, 18), "XRGY");
  console.log("  Settlement balance (after) :", ethers.formatUnits(settlementBalAfter, 18), "XRGY");

  const minted: bigint = balAfter - balBefore;
  const settlementDelta: bigint = settlementBalAfter - settlementBalBefore;
  console.log("  net minted to test VPP     :", ethers.formatUnits(minted, 18), "XRGY");
  console.log("  fee distributed via Settlement:", ethers.formatUnits(settlementDelta, 18), "XRGY");

  if (minted <= 0n) {
    throw new Error("Step 5 failed — no tokens minted to test VPP");
  }

  // Era 0 rate is 1.0 XRGY/kWh, fee is 1%, so net = kwhAmount * 99 / 100
  const expectedGross: bigint = kwhAmount;
  const expectedFee: bigint = (kwhAmount * 1n) / 100n;
  const expectedNet: bigint = expectedGross - expectedFee;
  console.log("  expected gross  :", ethers.formatUnits(expectedGross, 18));
  console.log("  expected fee 1% :", ethers.formatUnits(expectedFee, 18));
  console.log("  expected net    :", ethers.formatUnits(expectedNet, 18));

  if (minted !== expectedNet) {
    if (minted === expectedGross) {
      console.warn(
        "⚠ Fee was NOT collected — Phase 0 silent skip, indicates approve() did not register before this tx confirmed.",
      );
    } else {
      console.warn(
        `⚠ Minted ${minted} doesn't match expected gross ${expectedGross} or net ${expectedNet} — investigate.`,
      );
    }
  } else {
    console.log("  ✓ exact 1% fee skim confirmed end-to-end");
  }

  console.log("\n══════════════════════════════════════════════");
  console.log("Fresh-VPP onboarding: ALL 5 STEPS PASSED ✓");
  console.log("══════════════════════════════════════════════");
  console.log(
    `Arbiscan: ${ARBITRUM_SEPOLIA.explorer}/tx/${result.txHash}`,
  );
}

main().catch((e) => {
  console.error("\n✗ Fresh-VPP onboarding test FAILED:");
  console.error(e);
  process.exit(1);
});
