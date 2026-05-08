// OracleRouter — dual-signature trust boundary + device registry.
//
// SPEC: contracts/interfaces/IOracleRouter.sol + Technical_Blueprint.md §2.3 + §3.
//
// Anti-Simulation Lock (CORE_THESIS): single-signature packets MUST be rejected.
// Real value enters the system only when device hardware AND VPP cloud both
// attest to a measurement.

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployFullSystem } from "./helpers/fixtures";
import {
  devicePubKeyHash,
  makePacket,
  makeWallet,
  packetHash,
  signDevice,
  signVpp,
} from "./helpers/signatures";

describe("OracleRouter", () => {
  describe("device registry", () => {
    it("registers a device and emits DeviceRegistered", async () => {
      const { oracleRouter, governor, vppA } = await loadFixture(deployFullSystem);
      const device = makeWallet("dev-1");
      const deviceId = ethers.id("device-1");

      await expect(
        oracleRouter
          .connect(governor)
          .registerDevice(deviceId, await vppA.getAddress(), devicePubKeyHash(device))
      )
        .to.emit(oracleRouter, "DeviceRegistered")
        .withArgs(deviceId, await vppA.getAddress(), devicePubKeyHash(device));

      const rec = await oracleRouter.getDevice(deviceId);
      expect(rec.vppAddress).to.equal(await vppA.getAddress());
      expect(rec.devicePubKeyHash).to.equal(devicePubKeyHash(device));
      expect(rec.active).to.equal(true);
    });

    it("rejects duplicate registration", async () => {
      const { oracleRouter, governor, vppA } = await loadFixture(deployFullSystem);
      const device = makeWallet("dev-1");
      const deviceId = ethers.id("device-1");

      await oracleRouter
        .connect(governor)
        .registerDevice(deviceId, await vppA.getAddress(), devicePubKeyHash(device));

      await expect(
        oracleRouter
          .connect(governor)
          .registerDevice(deviceId, await vppA.getAddress(), devicePubKeyHash(device))
      ).to.be.revertedWithCustomError(oracleRouter, "DeviceAlreadyRegistered");
    });

    it("rejects registration from non-registrar", async () => {
      const { oracleRouter, attacker, vppA } = await loadFixture(deployFullSystem);
      const device = makeWallet("dev-1");
      await expect(
        oracleRouter
          .connect(attacker)
          .registerDevice(ethers.id("device-1"), await vppA.getAddress(), devicePubKeyHash(device))
      ).to.be.reverted; // AccessControl OR NotDeviceRegistrar
    });

    it("setDeviceActive toggles + emits event", async () => {
      const { oracleRouter, governor, vppA } = await loadFixture(deployFullSystem);
      const device = makeWallet("dev-1");
      const deviceId = ethers.id("device-1");
      await oracleRouter
        .connect(governor)
        .registerDevice(deviceId, await vppA.getAddress(), devicePubKeyHash(device));

      await expect(oracleRouter.connect(governor).setDeviceActive(deviceId, false))
        .to.emit(oracleRouter, "DeviceActiveStatusChanged")
        .withArgs(deviceId, false);

      const rec = await oracleRouter.getDevice(deviceId);
      expect(rec.active).to.equal(false);
    });
  });

  describe("submitMeasurement — dual signature requirement", () => {
    async function setupRegisteredDevice() {
      const sys = await loadFixture(deployFullSystem);
      const device = makeWallet("dev-A");
      const vppCloud = makeWallet("vpp-A-cloud");
      const deviceId = ethers.id("device-A");

      await sys.oracleRouter
        .connect(sys.governor)
        .registerDevice(deviceId, vppCloud.address, devicePubKeyHash(device));

      return { ...sys, device, vppCloud, deviceId };
    }

    it("ACCEPTS a packet signed by both device + VPP cloud", async () => {
      const { oracleRouter, device, vppCloud, deviceId } = await setupRegisteredDevice();
      const packet = makePacket({ deviceId, kwhAmount: 100n });
      const devSig = await signDevice(packet, device);
      const vppSig = await signVpp(packet, devSig, vppCloud);

      await expect(oracleRouter.submitMeasurement(packet, devSig, vppSig))
        .to.emit(oracleRouter, "MeasurementVerified")
        .withArgs(deviceId, vppCloud.address, 100n, packet.timestamp, anyEpoch);
    });

    it("REJECTS a packet with empty VPP signature (single-sig is forbidden)", async () => {
      const { oracleRouter, device, deviceId } = await setupRegisteredDevice();
      const packet = makePacket({ deviceId });
      const devSig = await signDevice(packet, device);
      await expect(
        oracleRouter.submitMeasurement(packet, devSig, "0x")
      ).to.be.reverted;
    });

    it("REJECTS a packet with empty device signature", async () => {
      const { oracleRouter, vppCloud, deviceId } = await setupRegisteredDevice();
      const packet = makePacket({ deviceId });
      // Must still produce *some* vpp sig to cover the inner branch.
      const vppSig = await signVpp(packet, "0x", vppCloud);
      await expect(
        oracleRouter.submitMeasurement(packet, "0x", vppSig)
      ).to.be.reverted;
    });

    it("REJECTS device signature from a different device", async () => {
      const { oracleRouter, vppCloud, deviceId } = await setupRegisteredDevice();
      const packet = makePacket({ deviceId });
      const otherDevice = makeWallet("not-the-device");
      const devSig = await signDevice(packet, otherDevice);
      const vppSig = await signVpp(packet, devSig, vppCloud);
      await expect(
        oracleRouter.submitMeasurement(packet, devSig, vppSig)
      ).to.be.revertedWithCustomError(oracleRouter, "InvalidDeviceSignature");
    });

    it("REJECTS VPP signature from a different VPP cloud", async () => {
      const { oracleRouter, device, deviceId } = await setupRegisteredDevice();
      const packet = makePacket({ deviceId });
      const wrongVpp = makeWallet("wrong-vpp");
      const devSig = await signDevice(packet, device);
      const vppSig = await signVpp(packet, devSig, wrongVpp);
      await expect(
        oracleRouter.submitMeasurement(packet, devSig, vppSig)
      ).to.be.revertedWithCustomError(oracleRouter, "InvalidVPPSignature");
    });

    it("REJECTS packets for deactivated devices", async () => {
      const { oracleRouter, governor, device, vppCloud, deviceId } =
        await setupRegisteredDevice();
      await oracleRouter.connect(governor).setDeviceActive(deviceId, false);

      const packet = makePacket({ deviceId });
      const devSig = await signDevice(packet, device);
      const vppSig = await signVpp(packet, devSig, vppCloud);
      await expect(
        oracleRouter.submitMeasurement(packet, devSig, vppSig)
      ).to.be.revertedWithCustomError(oracleRouter, "DeviceInactive");
    });

    it("REJECTS packets for unregistered devices", async () => {
      const { oracleRouter } = await loadFixture(deployFullSystem);
      const ghost = ethers.id("ghost-device");
      const dev = makeWallet("g-dev");
      const cloud = makeWallet("g-cloud");

      const packet = makePacket({ deviceId: ghost });
      const devSig = await signDevice(packet, dev);
      const vppSig = await signVpp(packet, devSig, cloud);

      await expect(
        oracleRouter.submitMeasurement(packet, devSig, vppSig)
      ).to.be.revertedWithCustomError(oracleRouter, "DeviceNotRegistered");
    });
  });

  describe("anti-replay", () => {
    it("rejects identical packet submitted twice", async () => {
      const sys = await loadFixture(deployFullSystem);
      const device = makeWallet("dev-replay");
      const vppCloud = makeWallet("vpp-replay");
      const deviceId = ethers.id("device-replay");

      await sys.oracleRouter
        .connect(sys.governor)
        .registerDevice(deviceId, vppCloud.address, devicePubKeyHash(device));

      const packet = makePacket({ deviceId, kwhAmount: 50n });
      const devSig = await signDevice(packet, device);
      const vppSig = await signVpp(packet, devSig, vppCloud);

      await sys.oracleRouter.submitMeasurement(packet, devSig, vppSig);
      expect(await sys.oracleRouter.isMeasurementProcessed(packetHash(packet))).to.equal(true);

      await expect(
        sys.oracleRouter.submitMeasurement(packet, devSig, vppSig)
      ).to.be.revertedWithCustomError(sys.oracleRouter, "DuplicateMeasurement");
    });

    it("ACCEPTS same kWh value as a NEW packet (different timestamp/cycles)", async () => {
      // Anti-replay is per *packet hash*, not per kWh value. A fresh measurement
      // for the same device, same kWh, but later timestamp must succeed.
      const sys = await loadFixture(deployFullSystem);
      const device = makeWallet("dev-twin");
      const vppCloud = makeWallet("vpp-twin");
      const deviceId = ethers.id("device-twin");

      await sys.oracleRouter
        .connect(sys.governor)
        .registerDevice(deviceId, vppCloud.address, devicePubKeyHash(device));

      const t0 = Math.floor(Date.now() / 1000);
      const a = makePacket({ deviceId, kwhAmount: 50n, timestamp: t0, cumulativeCycles: 1 });
      const b = makePacket({
        deviceId,
        kwhAmount: 50n,
        timestamp: t0 + 60,
        cumulativeCycles: 2,
      });

      const aDev = await signDevice(a, device);
      const aVpp = await signVpp(a, aDev, vppCloud);
      const bDev = await signDevice(b, device);
      const bVpp = await signVpp(b, bDev, vppCloud);

      await sys.oracleRouter.submitMeasurement(a, aDev, aVpp);
      await expect(sys.oracleRouter.submitMeasurement(b, bDev, bVpp)).to.not.be.reverted;
    });
  });

  describe("MintingEngine wiring", () => {
    it("setMintingEngine is one-shot", async () => {
      const { oracleRouter, governor, alice } = await loadFixture(deployFullSystem);
      await expect(
        oracleRouter.connect(governor).setMintingEngine(await alice.getAddress())
      ).to.be.revertedWithCustomError(oracleRouter, "MintingEngineAlreadySet");
    });
  });
});

// Chai matcher placeholder for "any uint" — avoids over-specifying epoch index.
const anyEpoch = (() => {
  const matcher = (actual: any) => typeof actual === "bigint" || typeof actual === "number";
  (matcher as any).asymmetricMatch = matcher;
  return matcher;
})();
