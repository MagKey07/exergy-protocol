// Growth rule (decided 20.10.2026): notes are minted only for energy that grows the
// stock — charge above the highest level a device has ever held. Recharging back to a
// level already reached mints nothing; daily cycling is paid by settlement, not by
// issuance. Discharge burns nothing: it only lowers the figure on every note.

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployFullSystem, ONE_TOKEN, netOfMintFee } from "./helpers/fixtures";

const CAPACITY = 10n; // a 10 kWh home battery

/** Emulate the OracleRouter: kWh and capacity in whole kWh, charge level in %. */
async function report(
  mintingEngine: any,
  oracleRouterAddr: string,
  deviceId: string,
  vppAddress: string,
  kwh: bigint,
  chargeLevelPercent: number,
  capacity: bigint = CAPACITY
) {
  const state = await mintingEngine.getDeviceCycleState(deviceId);
  const nextCycles = Number(state.lastCumulativeCycles) + (kwh > 0n ? 1 : 0);
  await ethers.provider.send("hardhat_impersonateAccount", [oracleRouterAddr]);
  await ethers.provider.send("hardhat_setBalance", [oracleRouterAddr, "0x56BC75E2D63100000"]);
  const signer = await ethers.getSigner(oracleRouterAddr);
  const tx = await mintingEngine
    .connect(signer)
    .commitVerifiedEnergy(deviceId, vppAddress, kwh * ONE_TOKEN, nextCycles, capacity * ONE_TOKEN, chargeLevelPercent);
  await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleRouterAddr]);
  return tx;
}

describe("Growth rule: notes only for growth of the stock", () => {
  async function setup() {
    const sys = await loadFixture(deployFullSystem);
    return {
      ...sys,
      oracle: await sys.oracleRouter.getAddress(),
      vpp: await sys.vppA.getAddress(),
      deviceId: ethers.id("carpenter-battery"),
    };
  }

  it("charge, spend, recharge to the same level: notes only for the first charge", async () => {
    const { mintingEngine, token, oracle, vpp, deviceId } = await setup();

    // Monday: 0 → 10 kWh from the sun. 10 notes.
    await report(mintingEngine, oracle, deviceId, vpp, 10n, 100);
    expect(await token.totalSupply()).to.equal(10n * ONE_TOKEN);
    expect(await mintingEngine.getFloatingIndex()).to.equal(ONE_TOKEN);

    // Monday evening: spent 7 kWh on the workshop. Nothing burns; the figure falls.
    await time.increase(3600);
    await report(mintingEngine, oracle, deviceId, vpp, 0n, 30);
    expect(await token.totalSupply()).to.equal(10n * ONE_TOKEN);
    expect(await mintingEngine.totalVerifiedEnergyInStorage()).to.equal(3n * ONE_TOKEN);

    // Tuesday: recharged 7 kWh back to 10. No new notes; the figure returns to 1.
    await time.increase(86_400);
    await expect(report(mintingEngine, oracle, deviceId, vpp, 7n, 100)).to.not.emit(mintingEngine, "EnergyMinted");
    expect(await token.totalSupply()).to.equal(10n * ONE_TOKEN);
    expect(await mintingEngine.totalVerifiedEnergyInStorage()).to.equal(10n * ONE_TOKEN);
    expect(await mintingEngine.getFloatingIndex()).to.equal(ONE_TOKEN);
  });

  it("a hundred daily cycles leave the figure on the note where it was", async () => {
    const { mintingEngine, token, oracle, vpp, deviceId } = await setup();
    await report(mintingEngine, oracle, deviceId, vpp, 10n, 100);
    for (let day = 0; day < 100; day++) {
      await time.increase(43_200);
      await report(mintingEngine, oracle, deviceId, vpp, 0n, 20); // evening: spent 8 kWh
      await time.increase(43_200);
      await report(mintingEngine, oracle, deviceId, vpp, 8n, 100); // day: recharged 8 kWh
    }
    expect(await token.totalSupply()).to.equal(10n * ONE_TOKEN);
    expect(await mintingEngine.getFloatingIndex()).to.equal(ONE_TOKEN);
  });

  it("charge above the previous high mints only the growth", async () => {
    const { mintingEngine, token, oracle, vpp, deviceId } = await setup();
    await report(mintingEngine, oracle, deviceId, vpp, 6n, 60); // high mark 6 kWh
    await time.increase(3600);
    await report(mintingEngine, oracle, deviceId, vpp, 0n, 20); // down to 2
    await time.increase(86_400);
    // Charged 8 kWh, from 2 to 10: only 4 kWh is above the previous high of 6.
    await expect(report(mintingEngine, oracle, deviceId, vpp, 8n, 100))
      .to.emit(mintingEngine, "EnergyMinted")
      .withArgs(deviceId, vpp, 4n * ONE_TOKEN, 4n * ONE_TOKEN, (v: any) => true, 0n);
    expect(await token.totalSupply()).to.equal(10n * ONE_TOKEN);
    expect(await mintingEngine.deviceMaxHeld(deviceId)).to.equal(10n * ONE_TOKEN);
  });

  it("an added battery module (larger capacity) mints its new stock", async () => {
    const { mintingEngine, token, oracle, vpp, deviceId } = await setup();
    await report(mintingEngine, oracle, deviceId, vpp, 10n, 100, 10n);
    await time.increase(86_400);
    // Same device re-attested at 15 kWh and filled: 5 kWh of new stock.
    await report(mintingEngine, oracle, deviceId, vpp, 5n, 100, 15n);
    expect(await token.totalSupply()).to.equal(15n * ONE_TOKEN);
  });

  it("never mints more than the new energy in the packet", async () => {
    const { mintingEngine, token, oracle, vpp, deviceId } = await setup();
    // Battery reports 100% of 10 kWh but only 3 kWh of new energy came in.
    await report(mintingEngine, oracle, deviceId, vpp, 3n, 100);
    expect(await token.totalSupply()).to.equal(3n * ONE_TOKEN);
  });

  it("charge already held on connection joins the stock and raises the high mark, minting nothing", async () => {
    const { mintingEngine, token, oracle, vpp, deviceId } = await setup();
    await report(mintingEngine, oracle, deviceId, vpp, 0n, 60); // connected holding 6 kWh
    expect(await token.totalSupply()).to.equal(0n);
    expect(await mintingEngine.deviceMaxHeld(deviceId)).to.equal(6n * ONE_TOKEN);
    await time.increase(86_400);
    await report(mintingEngine, oracle, deviceId, vpp, 4n, 100); // 6 → 10: 4 kWh of growth
    expect(await token.totalSupply()).to.equal(4n * ONE_TOKEN);
  });

  it("the mint split still applies to growth mints", async () => {
    const { mintingEngine, token, oracle, vpp, deviceId } = await setup();
    await report(mintingEngine, oracle, deviceId, vpp, 10n, 100);
    expect(await token.balanceOf(vpp)).to.equal(netOfMintFee(10n * ONE_TOKEN));
  });

  it("first charge packet of a new battery mints its new energy, never more", async () => {
    const { mintingEngine, token, oracle, vpp, deviceId } = await setup();
    // Connected holding 6 kWh and charged 4 kWh in the same packet: only the 4 kWh mint.
    await report(mintingEngine, oracle, deviceId, vpp, 4n, 100);
    expect(await token.totalSupply()).to.equal(4n * ONE_TOKEN);
    expect(await mintingEngine.deviceMaxHeld(deviceId)).to.equal(10n * ONE_TOKEN);
  });

  it("a battery cannot report a smaller capacity and then grow it back to mint again", async () => {
    const { mintingEngine, oracle, vpp, deviceId } = await setup();
    await report(mintingEngine, oracle, deviceId, vpp, 10n, 100, 10n);
    await time.increase(86_400);
    await expect(report(mintingEngine, oracle, deviceId, vpp, 0n, 100, 8n)).to.be.revertedWithCustomError(
      mintingEngine,
      "CapacityShrinkRejected"
    );
  });

  it("growth worth zero notes (rate 0 at the last era) records the charge without reverting", async () => {
    const { mintingEngine, token, oracle, vpp, deviceId, governor, deployer } = await setup();
    const role = await mintingEngine.TEST_HOOK_ROLE();
    await mintingEngine.connect(governor).grantRole(role, await deployer.getAddress());
    await mintingEngine.connect(deployer).adminSetEra(64);
    await report(mintingEngine, oracle, deviceId, vpp, 10n, 100);
    expect(await token.totalSupply()).to.equal(0n);
    expect(await mintingEngine.totalVerifiedEnergyInStorage()).to.equal(10n * ONE_TOKEN);
  });
});
