// Origin rules — decided by Mag 04.11.2026 (CORE_THESIS, block "РОЗЕТКА ДАЁТ НОТЫ, СОСЕД НЕТ, МИНИМУМ ДВОЕ").
//
//   1. Energy received from another participant mints nothing: it already stands behind
//      that participant's notes. It still lifts the battery's high-water mark.
//   2. Notes mint only in a community of at least two independent participants.
//      Independent = own metering point at the grid operator; batteries behind one point
//      are one participant.
//
// The device signs the physics; the community (VPP cloud) signs where the energy came from.

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { ONE_TOKEN, netOfMintFee, deployFullSystem } from "./helpers/fixtures";
import {
  devicePubKeyHash,
  makePacket,
  makeWallet,
  signDevice,
  signVpp,
  signVppWithOrigin,
} from "./helpers/signatures";

const KWH = ONE_TOKEN;

async function setup() {
  const sys = await loadFixture(deployFullSystem);
  const device = makeWallet("origin-device");
  const vppCloud = makeWallet("origin-vpp");
  const deviceId = ethers.id("origin-device");
  await sys.oracleRouter.connect(sys.governor).registerDevice(deviceId, vppCloud.address, devicePubKeyHash(device));
  await sys.oracleRouter.connect(sys.governor).setDeviceMeteringPoint(deviceId, ethers.id("MaLo-1"));
  return { ...sys, device, vppCloud, deviceId };
}

async function addParticipant(sys: any, name: string, point: string) {
  const id = ethers.id(name);
  await sys.oracleRouter.connect(sys.governor).registerDevice(id, sys.vppCloud.address, ethers.id("key:" + name));
  await sys.oracleRouter.connect(sys.governor).setDeviceMeteringPoint(id, ethers.id(point));
  return id;
}

let cycles = 0;
async function charge(sys: any, kwh: bigint, percent: number, fromMembers?: bigint) {
  const p = makePacket({
    deviceId: sys.deviceId,
    kwhAmount: kwh * KWH,
    storageCapacity: 100n * KWH,
    chargeLevelPercent: percent,
    cumulativeCycles: ++cycles,
    timestamp: await time.latest(),
  });
  const ds = await signDevice(p, sys.device);
  if (fromMembers === undefined) {
    return sys.oracleRouter.submitMeasurement(p, ds, await signVpp(p, ds, sys.vppCloud));
  }
  const vs = await signVppWithOrigin(p, ds, fromMembers * KWH, sys.vppCloud);
  return sys.oracleRouter.submitMeasurementWithOrigin(p, fromMembers * KWH, ds, vs);
}

describe("Origin rules (04.11.2026)", () => {
  beforeEach(() => {
    cycles = 0;
  });

  describe("minimum two independent participants", () => {
    it("a lone battery stores and reports but mints nothing", async () => {
      const sys = await setup();
      expect(await sys.oracleRouter.independentParticipants(sys.vppCloud.address)).to.equal(1n);
      await expect(charge(sys, 40n, 40))
        .to.emit(sys.oracleRouter, "EnergyNotMinting")
        .withArgs(sys.deviceId, sys.vppCloud.address, 40n * KWH, true);
      expect(await sys.token.totalSupply()).to.equal(0n);
      expect(await sys.mintingEngine.totalVerifiedEnergyInStorage()).to.equal(40n * KWH);
    });

    it("energy stored while alone never mints later: the high-water mark rose", async () => {
      const sys = await setup();
      await charge(sys, 40n, 40); // alone
      expect(await sys.mintingEngine.deviceMaxHeld(sys.deviceId)).to.equal(40n * KWH);
      await addParticipant(sys, "neighbour", "MaLo-2");
      // Discharge to 10, recharge to 40: back to a level already held, nothing new.
      await charge(sys, 0n, 10);
      await charge(sys, 30n, 40);
      expect(await sys.token.totalSupply()).to.equal(0n);
      // Charge above the old peak mints only the growth.
      await charge(sys, 20n, 60);
      expect(await sys.token.totalSupply()).to.equal(20n * ONE_TOKEN);
    });

    it("two batteries behind one metering point are one participant", async () => {
      const sys = await setup();
      await addParticipant(sys, "same-house-battery", "MaLo-1");
      expect(await sys.oracleRouter.independentParticipants(sys.vppCloud.address)).to.equal(1n);
      await charge(sys, 40n, 40);
      expect(await sys.token.totalSupply()).to.equal(0n);
    });

    it("a device without a metering point does not count", async () => {
      const sys = await setup();
      await sys.oracleRouter.connect(sys.governor).registerDevice(ethers.id("no-point"), sys.vppCloud.address, ethers.id("k"));
      expect(await sys.oracleRouter.independentParticipants(sys.vppCloud.address)).to.equal(1n);
    });

    it("a community of two mints", async () => {
      const sys = await setup();
      await addParticipant(sys, "neighbour", "MaLo-2");
      expect(await sys.oracleRouter.independentParticipants(sys.vppCloud.address)).to.equal(2n);
      await expect(charge(sys, 40n, 40)).to.not.emit(sys.oracleRouter, "EnergyNotMinting");
      expect(await sys.token.balanceOf(sys.vppCloud.address)).to.equal(netOfMintFee(40n * ONE_TOKEN));
    });

    it("deactivating the second participant stops minting again", async () => {
      const sys = await setup();
      const n = await addParticipant(sys, "neighbour", "MaLo-2");
      await sys.oracleRouter.connect(sys.governor).setDeviceActive(n, false);
      expect(await sys.oracleRouter.independentParticipants(sys.vppCloud.address)).to.equal(1n);
      await charge(sys, 40n, 40);
      expect(await sys.token.totalSupply()).to.equal(0n);
      await sys.oracleRouter.connect(sys.governor).setDeviceActive(n, true);
      expect(await sys.oracleRouter.independentParticipants(sys.vppCloud.address)).to.equal(2n);
    });

    it("moving a device to another metering point recounts", async () => {
      const sys = await setup();
      const n = await addParticipant(sys, "neighbour", "MaLo-1"); // same house first
      expect(await sys.oracleRouter.independentParticipants(sys.vppCloud.address)).to.equal(1n);
      await sys.oracleRouter.connect(sys.governor).setDeviceMeteringPoint(n, ethers.id("MaLo-2"));
      expect(await sys.oracleRouter.independentParticipants(sys.vppCloud.address)).to.equal(2n);
      await sys.oracleRouter.connect(sys.governor).setDeviceMeteringPoint(n, ethers.ZeroHash);
      expect(await sys.oracleRouter.independentParticipants(sys.vppCloud.address)).to.equal(1n);
    });

    it("a device not behind a metering point mints nothing, even in a community of two", async () => {
      const sys = await setup();
      await addParticipant(sys, "neighbour", "MaLo-2");
      await sys.oracleRouter.connect(sys.governor).setDeviceMeteringPoint(sys.deviceId, ethers.ZeroHash);
      await addParticipant(sys, "third", "MaLo-3");
      expect(await sys.oracleRouter.independentParticipants(sys.vppCloud.address)).to.equal(2n);
      await expect(charge(sys, 40n, 40))
        .to.emit(sys.oracleRouter, "EnergyNotMinting")
        .withArgs(sys.deviceId, sys.vppCloud.address, 40n * KWH, true);
      expect(await sys.token.totalSupply()).to.equal(0n);
    });

    it("only the registrar sets metering points", async () => {
      const sys = await setup();
      await expect(
        sys.oracleRouter.connect(sys.attacker).setDeviceMeteringPoint(sys.deviceId, ethers.id("x"))
      ).to.be.reverted;
    });
  });

  describe("energy from other participants mints nothing", () => {
    it("mints only the part of the charge that did not come from members", async () => {
      const sys = await setup();
      await addParticipant(sys, "neighbour", "MaLo-2");
      await expect(charge(sys, 50n, 50, 30n))
        .to.emit(sys.oracleRouter, "EnergyNotMinting")
        .withArgs(sys.deviceId, sys.vppCloud.address, 30n * KWH, false);
      expect(await sys.token.totalSupply()).to.equal(20n * ONE_TOKEN);
      expect(await sys.mintingEngine.totalVerifiedEnergyInStorage()).to.equal(50n * KWH);
    });

    it("a charge wholly from a neighbour mints nothing and still lifts the high-water mark", async () => {
      const sys = await setup();
      await addParticipant(sys, "neighbour", "MaLo-2");
      await charge(sys, 50n, 50, 50n);
      expect(await sys.token.totalSupply()).to.equal(0n);
      expect(await sys.mintingEngine.deviceMaxHeld(sys.deviceId)).to.equal(50n * KWH);
      // Discharging and recharging from own panels to the same level is not new stock.
      await charge(sys, 0n, 0);
      await charge(sys, 50n, 50, 0n);
      expect(await sys.token.totalSupply()).to.equal(0n);
    });

    it("received energy below the high-water mark changes nothing", async () => {
      const sys = await setup();
      await addParticipant(sys, "neighbour", "MaLo-2");
      await charge(sys, 60n, 60, 0n); // mints 60
      await charge(sys, 0n, 20);
      await charge(sys, 50n, 70, 40n); // growth 10, new energy 10 → mints 10
      expect(await sys.token.totalSupply()).to.equal(70n * ONE_TOKEN);
    });

    it("rejects a statement of more energy from members than the charge holds", async () => {
      const sys = await setup();
      await addParticipant(sys, "neighbour", "MaLo-2");
      await expect(charge(sys, 10n, 10, 11n)).to.be.revertedWithCustomError(
        sys.oracleRouter,
        "MembersEnergyExceedsCharge"
      );
    });

    it("the community's statement is signed: a relayer cannot lower it", async () => {
      const sys = await setup();
      await addParticipant(sys, "neighbour", "MaLo-2");
      const p = makePacket({
        deviceId: sys.deviceId,
        kwhAmount: 50n * KWH,
        storageCapacity: 100n * KWH,
        chargeLevelPercent: 50,
        cumulativeCycles: 1,
        timestamp: await time.latest(),
      });
      const ds = await signDevice(p, sys.device);
      const vs = await signVppWithOrigin(p, ds, 50n * KWH, sys.vppCloud);
      await expect(sys.oracleRouter.submitMeasurementWithOrigin(p, 0n, ds, vs)).to.be.revertedWithCustomError(
        sys.oracleRouter,
        "InvalidVPPSignature"
      );
    });

    it("one packet cannot be replayed through the other entry point", async () => {
      const sys = await setup();
      await addParticipant(sys, "neighbour", "MaLo-2");
      const p = makePacket({
        deviceId: sys.deviceId,
        kwhAmount: 50n * KWH,
        storageCapacity: 100n * KWH,
        chargeLevelPercent: 50,
        cumulativeCycles: 1,
        timestamp: await time.latest(),
      });
      const ds = await signDevice(p, sys.device);
      await sys.oracleRouter.submitMeasurementWithOrigin(p, 50n * KWH, ds, await signVppWithOrigin(p, ds, 50n * KWH, sys.vppCloud));
      await expect(
        sys.oracleRouter.submitMeasurement(p, ds, await signVpp(p, ds, sys.vppCloud))
      ).to.be.revertedWithCustomError(sys.oracleRouter, "DuplicateMeasurement");
    });
  });
});
