/**
 * End-to-end worked example: submit a single dual-signed measurement
 * packet to OracleRouter on Arbitrum Sepolia.
 *
 * This script demonstrates every primitive a real VPP cloud connector
 * needs. It is intentionally short — the entire VPP integration is this
 * file plus your existing telemetry pipeline.
 *
 * Prerequisites (one-time, see VPP_INTEGRATION_GUIDE.md §4):
 *   1. Your VPP cloud wallet must hold CHAINLINK_RELAYER_ROLE on the
 *      OracleRouter contract.
 *   2. The deviceId you submit for must be registered against your VPP
 *      cloud wallet.
 *   3. Your VPP cloud wallet must have approved Settlement on
 *      XRGYToken (MaxUint256).
 *   4. Your VPP cloud wallet must hold a small amount of Sepolia ETH
 *      for gas (~0.001 ETH per submission).
 *
 * Environment variables:
 *   VPP_CLOUD_PRIVATE_KEY    — 0x-prefixed 64-hex of your VPP cloud signer
 *   DEVICE_LABEL             — label used to derive the device key
 *                              deterministically. Use the same label
 *                              that was used at registration time.
 *   VPP_LABEL                — label used to derive the VPP cloud key
 *                              when the cloud key itself is also
 *                              derived deterministically (testnet
 *                              shortcut). Optional. Ignored if
 *                              VPP_CLOUD_PRIVATE_KEY is set.
 *   ARBITRUM_SEPOLIA_RPC_URL — optional, defaults to public node.
 *
 * Run: `npx ts-node examples/submit-one-packet.ts`
 */

import "dotenv/config";
import { ethers } from "ethers";

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
} from "../src";
import type { MeasurementPacket } from "../src";

function fromSeed(label: string): ethers.Wallet {
  const pk = ethers.keccak256(ethers.toUtf8Bytes(`exergy-vpp:${label}`));
  return new ethers.Wallet(pk);
}

async function main() {
  // ───────── 0. Wire up provider + wallets ─────────
  const rpcUrl =
    process.env.ARBITRUM_SEPOLIA_RPC_URL ?? ARBITRUM_SEPOLIA.rpcUrl;
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  const vppCloudWallet = process.env.VPP_CLOUD_PRIVATE_KEY
    ? new ethers.Wallet(process.env.VPP_CLOUD_PRIVATE_KEY, provider)
    : fromSeed(`vpp:${process.env.VPP_LABEL ?? "smoke-vpp"}`).connect(provider);

  const deviceLabel =
    process.env.DEVICE_LABEL ??
    `${process.env.VPP_LABEL ?? "smoke-vpp"}:device-000`;
  const deviceWallet = fromSeed(deviceLabel);

  console.log("VPP cloud wallet :", vppCloudWallet.address);
  console.log("Device wallet    :", deviceWallet.address);
  console.log("Device label     :", deviceLabel);
  console.log();

  // ───────── 1. Pre-flight checks ─────────
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== ARBITRUM_SEPOLIA.chainId) {
    throw new Error(
      `Connected to chainId ${network.chainId}, expected ${ARBITRUM_SEPOLIA.chainId} (Arbitrum Sepolia)`,
    );
  }

  const ethBalance = await provider.getBalance(vppCloudWallet.address);
  console.log("VPP cloud ETH balance:", ethers.formatEther(ethBalance));
  if (ethBalance < ethers.parseEther("0.0005")) {
    console.warn("⚠  Low ETH balance — top up to at least 0.001 ETH on Arbitrum Sepolia.");
  }

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

  const relayerRole = ethers.id("CHAINLINK_RELAYER_ROLE");
  const hasRelayerRole = await router.hasRole(
    relayerRole,
    vppCloudWallet.address,
  );
  console.log("Has CHAINLINK_RELAYER_ROLE:", hasRelayerRole);
  if (!hasRelayerRole) {
    throw new Error(
      "VPP cloud wallet does not hold CHAINLINK_RELAYER_ROLE on OracleRouter. " +
        "Request a grant from the protocol team — see VPP_INTEGRATION_GUIDE.md §4.1.",
    );
  }

  const deviceId = ethers.id(`exergy-device:${deviceLabel}`);
  const device = await router.getDevice(deviceId);
  console.log("On-chain deviceId:", deviceId);
  console.log("  vppAddress    :", device.vppAddress);
  console.log("  active        :", device.active);
  console.log("  pubKeyHash    :", device.devicePubKeyHash);

  if (device.vppAddress === ethers.ZeroAddress) {
    const expected = devicePubKeyHashFor(deviceWallet.address);
    throw new Error(
      `deviceId ${deviceId} is not registered.\n` +
        `Ask the protocol team to register it with:\n` +
        `  registerDevice(${deviceId}, ${vppCloudWallet.address}, ${expected})`,
    );
  }
  if (
    device.devicePubKeyHash.toLowerCase() !==
    devicePubKeyHashFor(deviceWallet.address).toLowerCase()
  ) {
    throw new Error(
      `Registered devicePubKeyHash does not match the device wallet — ` +
        `you cannot sign for this device with the current key.`,
    );
  }

  const settlementAllowance = await token.allowance(
    vppCloudWallet.address,
    ARBITRUM_SEPOLIA.contracts.settlement,
  );
  console.log("Settlement allowance:", ethers.formatUnits(settlementAllowance, 18), "XRGY");
  if (settlementAllowance < ethers.parseUnits("1000", 18)) {
    console.warn(
      "⚠  Low Settlement allowance — call XRGYToken.approve(SETTLEMENT, MaxUint256) " +
        "from your VPP cloud wallet, otherwise fees will be silently skipped (Phase 0 only).",
    );
  }

  // ───────── 2. Build a packet ─────────
  const cycleState = await engine.getDeviceCycleState(deviceId);
  console.log("\nOn-chain cycle state for this device:");
  console.log("  initialized          :", cycleState.initialized);
  console.log("  lastCumulativeCycles :", cycleState.lastCumulativeCycles.toString());
  console.log("  lastEpoch            :", cycleState.lastEpoch.toString());
  console.log("  storageCapacity      :", ethers.formatUnits(cycleState.storageCapacity, 18), "kWh");

  const cumulativeCycles =
    Number(cycleState.lastCumulativeCycles) > 0
      ? Number(cycleState.lastCumulativeCycles) + 1 // +1 cycle this packet
      : 1; // first packet

  const packet: MeasurementPacket = {
    deviceId,
    kwhAmount: kwhToWad(1.0), // 1 kWh — small first-pass test
    timestamp: BigInt(Math.floor(Date.now() / 1000)),
    storageCapacity: kwhToWad(13.5), // standard Powerwall-class capacity
    chargeLevelPercent: 75,
    sourceType: SourceType.Solar,
    cumulativeCycles,
  };

  const packetHash = buildPacketHash(packet);
  console.log("\nPacket prepared:");
  console.log("  deviceId         :", packet.deviceId);
  console.log("  kwhAmount        :", ethers.formatUnits(packet.kwhAmount, 18), "kWh");
  console.log("  timestamp        :", packet.timestamp.toString());
  console.log("  storageCapacity  :", ethers.formatUnits(packet.storageCapacity, 18), "kWh");
  console.log("  chargeLevelPercent:", packet.chargeLevelPercent);
  console.log("  sourceType       :", SourceType[packet.sourceType]);
  console.log("  cumulativeCycles :", packet.cumulativeCycles);
  console.log("  packetHash       :", packetHash);

  const alreadyProcessed = await router.isMeasurementProcessed(packetHash);
  if (alreadyProcessed) {
    console.warn("⚠  This exact packetHash was already submitted — change timestamp or cycles to retry.");
    return;
  }

  // ───────── 3. Sign ─────────
  const signed = await signPacket({
    packet,
    deviceWallet,
    vppCloudWallet,
  });
  console.log("\nSigned:");
  console.log("  deviceSignature  :", signed.deviceSignature.slice(0, 20) + "…");
  console.log("  vppSignature     :", signed.vppSignature.slice(0, 20) + "…");

  // ───────── 4. Simulate before paying for gas ─────────
  console.log("\nSimulating submission (staticCall)…");
  const simErr = await simulateSubmitMeasurement({
    packet,
    signed,
    oracleRouterAddress: ARBITRUM_SEPOLIA.contracts.oracleRouter,
    signer: vppCloudWallet,
  });
  if (simErr) {
    console.error("✗ Simulation failed:", simErr);
    return;
  }
  console.log("✓ Simulation succeeded — submitting on-chain.");

  // ───────── 5. Submit ─────────
  const balanceBefore = await token.balanceOf(vppCloudWallet.address);

  const result = await submitMeasurement({
    packet,
    signed,
    oracleRouterAddress: ARBITRUM_SEPOLIA.contracts.oracleRouter,
    signer: vppCloudWallet,
  });

  const balanceAfter = await token.balanceOf(vppCloudWallet.address);
  const minted = balanceAfter - balanceBefore;

  console.log("\n✓ Submitted:");
  console.log("  tx               :", result.txHash);
  console.log("  block            :", result.blockNumber);
  console.log("  gas used         :", result.gasUsed.toString());
  console.log("  XRGY received    :", ethers.formatUnits(minted, 18));
  console.log(
    "  arbiscan         :",
    `${ARBITRUM_SEPOLIA.explorer}/tx/${result.txHash}`,
  );
}

main().catch((err) => {
  console.error("\n✗ Failed:");
  console.error(err);
  process.exit(1);
});
