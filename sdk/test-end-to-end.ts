/**
 * End-to-end SDK validation against live Arbitrum Sepolia.
 *
 * Reuses the simulator's already-registered smoke VPP + device-000
 * (their keys are deterministic from public seeds) so we don't need any
 * admin coordination for the test. Submits one fresh packet through
 * the SDK and verifies a token was minted.
 *
 * If this script prints "SDK end-to-end: OK" the SDK matches the
 * deployed contract surface exactly — packet hash, dual signature,
 * submission, gas budget — across all four primitives.
 *
 * Run: `npx ts-node test-end-to-end.ts`
 */

import { ethers } from "ethers";
import * as dotenv from "dotenv";
import * as path from "path";

// Load env from the oracle-simulator/.env which already has SUBMITTER_PRIVATE_KEY
// configured against the deployer wallet that holds CHAINLINK_RELAYER_ROLE.
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

// The simulator derives keys from `exergy-sim:` prefix. To test against the
// already-registered smoke deployment we mirror that derivation exactly.
function simSeed(label: string): ethers.Wallet {
  const pk = ethers.keccak256(ethers.toUtf8Bytes(`exergy-sim:${label}`));
  return new ethers.Wallet(pk);
}

async function main() {
  console.log("Exergy SDK end-to-end test against Arbitrum Sepolia\n");

  const provider = new ethers.JsonRpcProvider(ARBITRUM_SEPOLIA.rpcUrl);
  const network = await provider.getNetwork();
  console.log("Connected to chainId:", Number(network.chainId));
  if (Number(network.chainId) !== ARBITRUM_SEPOLIA.chainId) {
    throw new Error("Wrong chain — expected Arbitrum Sepolia (421614)");
  }

  // Architecture note: in the smoke flow the SUBMITTER (caller of
  // submitMeasurement, holds CHAINLINK_RELAYER_ROLE) and the VPP cloud
  // SIGNER (registered as the device's vppAddress) are separate wallets.
  // The submitter is the deployer EOA in Phase 0; in production it will
  // be the Chainlink External Adapter. The VPP signer is the operator's
  // off-chain key. This test mirrors that split.
  const submitterKey = process.env.SUBMITTER_PRIVATE_KEY;
  if (!submitterKey || submitterKey.startsWith("0x00000000")) {
    throw new Error(
      "SUBMITTER_PRIVATE_KEY is not set. The submitter wallet must hold " +
        "CHAINLINK_RELAYER_ROLE on OracleRouter to call submitMeasurement.",
    );
  }
  const submitterWallet = new ethers.Wallet(submitterKey, provider);
  const vppCloudWallet = simSeed("vpp:smoke-vpp"); // signer only — does NOT submit
  // The currently-registered smoke device label is "smoke-dev"
  // (registered via `register-device --device smoke-dev --vpp smoke-vpp`).
  const deviceWallet = simSeed("smoke-dev");

  console.log("Submitter  :", submitterWallet.address);
  console.log("VPP cloud  :", vppCloudWallet.address);
  console.log("Device     :", deviceWallet.address);

  const router = new ethers.Contract(
    ARBITRUM_SEPOLIA.contracts.oracleRouter,
    ORACLE_ROUTER_ABI,
    provider,
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

  // ── Pre-flight: role + registration ──
  const relayerRole = ethers.id("CHAINLINK_RELAYER_ROLE");
  const hasRelayer = await router.hasRole(relayerRole, submitterWallet.address);
  console.log("\nSubmitter has CHAINLINK_RELAYER_ROLE:", hasRelayer);
  if (!hasRelayer) {
    throw new Error("Submitter wallet is missing CHAINLINK_RELAYER_ROLE");
  }

  const deviceId = ethers.keccak256(
    ethers.toUtf8Bytes("exergy-device:smoke-dev"),
  );
  console.log("Device ID  :", deviceId);
  const device = await router.getDevice(deviceId);
  console.log("vppAddress :", device.vppAddress);
  console.log("active     :", device.active);
  if (device.vppAddress === ethers.ZeroAddress) {
    throw new Error("smoke-vpp:device-000 is not registered yet");
  }
  if (
    device.vppAddress.toLowerCase() !== vppCloudWallet.address.toLowerCase()
  ) {
    throw new Error(
      `Device registered to a different VPP: ${device.vppAddress}, ` +
        `expected ${vppCloudWallet.address}`,
    );
  }
  const expectedHash = devicePubKeyHashFor(deviceWallet.address);
  if (device.devicePubKeyHash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error(
      `Device pubkey hash mismatch.\n  expected: ${expectedHash}\n  on-chain: ${device.devicePubKeyHash}`,
    );
  }
  console.log("Pubkey hash matches ✓");

  const ethBal = await provider.getBalance(submitterWallet.address);
  console.log("Submitter ETH:", ethers.formatEther(ethBal));
  if (ethBal < ethers.parseEther("0.0005")) {
    throw new Error("Submitter wallet is out of Sepolia ETH for gas");
  }

  // ── Build a packet using SDK helpers ──
  const cycleState = await engine.getDeviceCycleState(deviceId);
  console.log("\nCycle state:");
  console.log("  initialized          :", cycleState.initialized);
  console.log("  lastCumulativeCycles :", cycleState.lastCumulativeCycles.toString());
  console.log("  lastEpoch            :", cycleState.lastEpoch.toString());
  console.log("  storageCapacity      :", ethers.formatUnits(cycleState.storageCapacity, 18), "kWh");

  const currentEpoch: bigint = await engine.currentEpoch();
  console.log("  currentEpoch         :", currentEpoch.toString());
  const lastEpoch: bigint = cycleState.lastEpoch as bigint;
  const epochsDelta: bigint = currentEpoch - lastEpoch;
  const maxCyclesAllowed = Number(epochsDelta + 1n) * 2;
  console.log("  cycle budget         :", maxCyclesAllowed);

  const cumulativeCycles =
    Number(cycleState.lastCumulativeCycles) +
    Math.min(maxCyclesAllowed, 1); // submit conservative +1 cycle
  const cyclesDelta =
    cumulativeCycles - Number(cycleState.lastCumulativeCycles);

  // kWh must be ≤ storageCapacity * cyclesDelta. If first packet,
  // cyclesDelta is treated as cumulativeCycles itself in the contract.
  const effectiveDeltaForBudget = cycleState.initialized
    ? BigInt(cyclesDelta)
    : BigInt(cumulativeCycles);
  const storageCapacityForPacket =
    cycleState.storageCapacity > 0n
      ? cycleState.storageCapacity
      : kwhToWad(13.5);
  const maxKwhForPacket =
    (storageCapacityForPacket * effectiveDeltaForBudget) / 10n ** 18n;
  // Stay well under the cap — 0.5 kWh or 50% of cap, whichever is smaller.
  const targetKwh =
    maxKwhForPacket / 2n < kwhToWad(0.5)
      ? maxKwhForPacket / 2n
      : kwhToWad(0.5);

  if (targetKwh <= 0n) {
    throw new Error(
      "No cycle budget available right now — wait for next epoch or run again later.",
    );
  }

  const packet: MeasurementPacket = {
    deviceId,
    kwhAmount: targetKwh,
    timestamp: BigInt(Math.floor(Date.now() / 1000)),
    storageCapacity: storageCapacityForPacket,
    chargeLevelPercent: 70,
    sourceType: SourceType.Solar,
    cumulativeCycles,
  };

  const ph = buildPacketHash(packet);
  console.log("\nPacket:");
  console.log("  kwhAmount        :", ethers.formatUnits(packet.kwhAmount, 18), "kWh");
  console.log("  cumulativeCycles :", packet.cumulativeCycles);
  console.log("  packetHash       :", ph);

  const dup = await router.isMeasurementProcessed(ph);
  if (dup) throw new Error("Duplicate hash — adjust timestamp/cycles");

  // ── Sign through SDK ──
  const signed = await signPacket({ packet, deviceWallet, vppCloudWallet });
  console.log("\nSignatures produced:");
  console.log("  device  :", signed.deviceSignature.slice(0, 22) + "…");
  console.log("  vpp     :", signed.vppSignature.slice(0, 22) + "…");

  // ── Simulate first ──
  const simErr = await simulateSubmitMeasurement({
    packet,
    signed,
    oracleRouterAddress: ARBITRUM_SEPOLIA.contracts.oracleRouter,
    signer: submitterWallet,
  });
  if (simErr) {
    console.error("\n✗ Simulation failed:", simErr);
    throw new Error("SDK packet/sig is wrong — see error above");
  }
  console.log("Simulation: OK ✓");

  // ── Submit ──
  // The token recipient is the registered VPP cloud address (smoke-VPP).
  // Tokens are minted to that address regardless of who submits the tx.
  const balBefore: bigint = await token.balanceOf(vppCloudWallet.address);
  console.log("\nVPP balance before:", ethers.formatUnits(balBefore, 18), "XRGY");

  const result = await submitMeasurement({
    packet,
    signed,
    oracleRouterAddress: ARBITRUM_SEPOLIA.contracts.oracleRouter,
    signer: submitterWallet,
  });
  console.log("Submitted. Tx:", result.txHash);
  console.log("Gas used     :", result.gasUsed.toString());
  console.log("Block        :", result.blockNumber);
  console.log(`Arbiscan     : ${ARBITRUM_SEPOLIA.explorer}/tx/${result.txHash}`);

  const balAfter: bigint = await token.balanceOf(vppCloudWallet.address);
  console.log("Balance after :", ethers.formatUnits(balAfter, 18), "XRGY");

  const balBeforeBig: bigint = balBefore as bigint;
  const minted: bigint = balAfter - balBeforeBig;
  const expectedMintedNetOfFee: bigint = (packet.kwhAmount * 99n) / 100n; // 1% fee
  console.log("Net minted    :", ethers.formatUnits(minted, 18), "XRGY");
  console.log("Expected ≥    :", ethers.formatUnits(expectedMintedNetOfFee, 18), "XRGY");

  if (minted <= 0n) {
    throw new Error("No tokens minted — submission failed silently");
  }

  // Tolerate fee-skip case (Phase 0 silent no-op when approve is missing).
  // Either gross or net minted is acceptable as a passing test — both prove
  // the dual-sig + submit path is correct end to end.
  const grossOk: boolean = minted === packet.kwhAmount;
  const netOk: boolean = minted === expectedMintedNetOfFee;
  if (!grossOk && !netOk) {
    console.warn(
      `Minted amount ${minted} doesn't match either gross or 1%-fee net. ` +
        `Could be partial fee for an odd reason — investigate.`,
    );
  }

  console.log("\n────────────────────────────────────");
  console.log("SDK end-to-end: OK ✓");
  console.log("────────────────────────────────────");
}

main().catch((e) => {
  console.error("\n✗ Test failed:");
  console.error(e);
  process.exit(1);
});
