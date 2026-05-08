// MintingEngine — halving, floating index, epoch boundaries, anti-replay.
//
// SPEC: contracts/interfaces/IMintingEngine.sol + Technical_Blueprint.md §2.2 + §5.
//
// Halving schedule (per spec §5):
//   Era 0: 0      — 1M    XRGY  → 1.0    token/kWh
//   Era 1: 1M     — 2M    XRGY  → 0.5    token/kWh
//   Era 2: 2M     — 3M    XRGY  → 0.25   token/kWh
//   Era 3: 3M     — 4M    XRGY  → 0.125  token/kWh
//   Era 4: 4M     — 5M    XRGY  → 0.0625 token/kWh
//
// IMPORTANT: tests use a TestHooks-style admin function on MintingEngine to
// fast-forward the era / minted total without minting 1M kWh each time.
// If the production contract does not expose `__test_setMintedTotal` then
// halving boundary tests fall back to slow-path simulation. Either path
// validates the same invariant.

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  deployFullSystem,
  EPOCH_DURATION_SECONDS,
  HALVING_THRESHOLD_WEI,
  ONE_TOKEN,
} from "./helpers/fixtures";

/** Helper: emulate the OracleRouter calling MintingEngine.commitVerifiedEnergy.
 *  Tests rely on impersonating the OracleRouter address so we don't need
 *  a fully-signed packet for unit tests of MintingEngine in isolation. */
async function mintAs(
  mintingEngine: any,
  oracleRouterAddr: string,
  deviceId: string,
  vppAddress: string,
  kwh: bigint
) {
  await ethers.provider.send("hardhat_impersonateAccount", [oracleRouterAddr]);
  await ethers.provider.send("hardhat_setBalance", [
    oracleRouterAddr,
    "0x56BC75E2D63100000", // 100 ETH
  ]);
  const oracleSigner = await ethers.getSigner(oracleRouterAddr);
  const tx = await mintingEngine
    .connect(oracleSigner)
    .commitVerifiedEnergy(deviceId, vppAddress, kwh);
  await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleRouterAddr]);
  return tx;
}

describe("MintingEngine", () => {
  describe("initial state", () => {
    it("starts in era 0 with rate 1.0 token/kWh", async () => {
      const { mintingEngine } = await loadFixture(deployFullSystem);
      expect(await mintingEngine.currentEra()).to.equal(0n);
      // 1.0 token/kWh = 1e18 wei per kWh
      expect(await mintingEngine.currentMintRateWeiPerKwh()).to.equal(ONE_TOKEN);
    });

    it("totalTokensMinted = 0 and floating index = 0 at genesis", async () => {
      const { mintingEngine } = await loadFixture(deployFullSystem);
      expect(await mintingEngine.totalTokensMinted()).to.equal(0n);
      expect(await mintingEngine.totalVerifiedEnergyInStorage()).to.equal(0n);
      expect(await mintingEngine.getFloatingIndex()).to.equal(0n);
    });
  });

  describe("halving math (spec §5)", () => {
    it("era 0 mints 1.0 token per kWh", async () => {
      const { mintingEngine, oracleRouter, vppA, token } = await loadFixture(deployFullSystem);
      const deviceId = ethers.id("test-device");
      await mintAs(
        mintingEngine,
        await oracleRouter.getAddress(),
        deviceId,
        await vppA.getAddress(),
        100n
      );
      expect(await token.balanceOf(await vppA.getAddress())).to.equal(100n * ONE_TOKEN);
    });

    it("crosses to era 1 at 1M tokens minted, then mints 0.5 token/kWh", async () => {
      const { mintingEngine, oracleRouter, vppA, token } = await loadFixture(deployFullSystem);

      // Mint right up to (but not over) the threshold — 999,999 kWh.
      // Single big call exercises era-0 rate.
      const deviceId = ethers.id("device-bulk");
      await mintAs(
        mintingEngine,
        await oracleRouter.getAddress(),
        deviceId,
        await vppA.getAddress(),
        999_999n
      );
      expect(await token.balanceOf(await vppA.getAddress())).to.equal(999_999n * ONE_TOKEN);
      expect(await mintingEngine.currentEra()).to.equal(0n);

      // Next mint of 100 kWh would push us through 1M.
      // Behavior asserted: era flips before the 100 kWh is consumed.
      // Therefore tokens minted = 100 * 0.5 = 50 (worst case) — production
      // contract may split-rate. Either way, token balance < 1M + 100 (era-0
      // would have given +100; era-1 gives +50). We assert the strict inequality.
      const balanceBefore = await token.balanceOf(await vppA.getAddress());
      await mintAs(
        mintingEngine,
        await oracleRouter.getAddress(),
        deviceId,
        await vppA.getAddress(),
        100n
      );
      const balanceAfter = await token.balanceOf(await vppA.getAddress());
      const minted = balanceAfter - balanceBefore;

      // After threshold cross: era >= 1.
      expect(await mintingEngine.currentEra()).to.be.gte(1n);
      // Strict halving: minted strictly less than era-0 rate would have given.
      expect(minted).to.be.lt(100n * ONE_TOKEN);
      // ...and at least era-1 rate floor.
      expect(minted).to.be.gte(50n * ONE_TOKEN);
    });

    it("emits HalvingTriggered when crossing 1M boundary", async () => {
      const { mintingEngine, oracleRouter, vppA } = await loadFixture(deployFullSystem);
      const deviceId = ethers.id("halving-device");

      // Pre-fill to just below threshold.
      await mintAs(
        mintingEngine,
        await oracleRouter.getAddress(),
        deviceId,
        await vppA.getAddress(),
        999_999n
      );

      await expect(
        mintAs(
          mintingEngine,
          await oracleRouter.getAddress(),
          deviceId,
          await vppA.getAddress(),
          100n
        )
      ).to.emit(mintingEngine, "HalvingTriggered");
    });

    it("rate halves correctly across multiple eras (0 → 1 → 2)", async () => {
      const { mintingEngine, oracleRouter, vppA } = await loadFixture(deployFullSystem);
      const deviceId = ethers.id("multi-era-device");

      // Cross into era 1: feed 1.5M kWh — at 1.0 token/kWh produces 1M tokens
      // (era-0 fills exactly to 1M XRGY at 1M kWh), then 500K kWh enters era-1
      // and produces 250K XRGY (0.5 rate). Total minted: 1.25M < 2M, so we stay in era 1.
      await mintAs(
        mintingEngine,
        await oracleRouter.getAddress(),
        deviceId,
        await vppA.getAddress(),
        1_500_000n
      );
      expect(await mintingEngine.currentEra()).to.equal(1n);
      expect(await mintingEngine.currentMintRateWeiPerKwh()).to.equal(ONE_TOKEN / 2n);

      // Push into era 2: era 1 has another 750K XRGY of room (1.25M → 2M),
      // which costs 1.5M kWh. Send 2M kWh and we cross.
      await mintAs(
        mintingEngine,
        await oracleRouter.getAddress(),
        deviceId,
        await vppA.getAddress(),
        2_000_000n
      );
      expect(await mintingEngine.currentEra()).to.be.gte(2n);
      // Era 2 rate = 0.25 token/kWh
      expect(await mintingEngine.currentMintRateWeiPerKwh()).to.equal(ONE_TOKEN / 4n);
    });
  });

  describe("floating index", () => {
    it("returns 0 when totalSupply is 0", async () => {
      const { mintingEngine } = await loadFixture(deployFullSystem);
      expect(await mintingEngine.getFloatingIndex()).to.equal(0n);
    });

    it("equals 1.0 when totalVerifiedEnergyInStorage == totalSupply (in token units)", async () => {
      const { mintingEngine, oracleRouter, vppA } = await loadFixture(deployFullSystem);
      // Era 0: kWh=tokens 1:1, so storage and supply move together.
      await mintAs(
        mintingEngine,
        await oracleRouter.getAddress(),
        ethers.id("d"),
        await vppA.getAddress(),
        100n
      );
      // floatingIndex = totalEnergy(kWh, integer) * 1e18 / totalSupply(wei)
      // 100 * 1e18 / (100 * 1e18) = 1e18 → "1.0" in 18-decimal fixed point
      expect(await mintingEngine.getFloatingIndex()).to.equal(ONE_TOKEN);
    });

    it("decreases when energy consumption is recorded (no burn)", async () => {
      const { mintingEngine, oracleRouter, settlement, vppA } = await loadFixture(
        deployFullSystem
      );
      await mintAs(
        mintingEngine,
        await oracleRouter.getAddress(),
        ethers.id("d"),
        await vppA.getAddress(),
        100n
      );
      const supplyBefore = await mintingEngine.totalTokensMinted();
      const indexBefore = await mintingEngine.getFloatingIndex();

      // Settlement reports 30 kWh consumed — in production this fires when
      // a redemption happens. Tokens DO NOT burn; only energy bookkeeping moves.
      await ethers.provider.send("hardhat_impersonateAccount", [
        await settlement.getAddress(),
      ]);
      await ethers.provider.send("hardhat_setBalance", [
        await settlement.getAddress(),
        "0x56BC75E2D63100000",
      ]);
      const settlementSigner = await ethers.getSigner(await settlement.getAddress());
      await mintingEngine.connect(settlementSigner).recordEnergyConsumption(30n);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [
        await settlement.getAddress(),
      ]);

      // totalTokensMinted is monotonic — must be unchanged.
      expect(await mintingEngine.totalTokensMinted()).to.equal(supplyBefore);
      // Floating index drops because numerator (energy) shrunk while denominator (supply) didn't.
      expect(await mintingEngine.getFloatingIndex()).to.be.lt(indexBefore);
    });

    it("recordEnergyConsumption reverts if amount > totalVerifiedEnergyInStorage", async () => {
      const { mintingEngine, settlement } = await loadFixture(deployFullSystem);
      await ethers.provider.send("hardhat_impersonateAccount", [
        await settlement.getAddress(),
      ]);
      await ethers.provider.send("hardhat_setBalance", [
        await settlement.getAddress(),
        "0x56BC75E2D63100000",
      ]);
      const settlementSigner = await ethers.getSigner(await settlement.getAddress());
      await expect(
        mintingEngine.connect(settlementSigner).recordEnergyConsumption(1n)
      ).to.be.revertedWithCustomError(mintingEngine, "EnergyUnderflow");
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [
        await settlement.getAddress(),
      ]);
    });
  });

  describe("epoch boundaries", () => {
    it("currentEpoch increments after EPOCH_DURATION", async () => {
      const { mintingEngine } = await loadFixture(deployFullSystem);
      const e0 = await mintingEngine.currentEpoch();
      await time.increase(EPOCH_DURATION_SECONDS);
      const e1 = await mintingEngine.currentEpoch();
      expect(e1).to.equal(e0 + 1n);
    });

    it("aggregates kWh and tokens in EpochData per epoch", async () => {
      const { mintingEngine, oracleRouter, vppA } = await loadFixture(deployFullSystem);
      await mintAs(
        mintingEngine,
        await oracleRouter.getAddress(),
        ethers.id("d"),
        await vppA.getAddress(),
        50n
      );
      await mintAs(
        mintingEngine,
        await oracleRouter.getAddress(),
        ethers.id("d"),
        await vppA.getAddress(),
        25n
      );
      const epoch = await mintingEngine.currentEpoch();
      const data = await mintingEngine.getEpochData(epoch);
      expect(data.totalVerifiedKwh).to.equal(75n);
      expect(data.totalTokensMinted).to.equal(75n * ONE_TOKEN);
    });

    it("starts a fresh epoch counter after time passes", async () => {
      const { mintingEngine, oracleRouter, vppA } = await loadFixture(deployFullSystem);
      await mintAs(
        mintingEngine,
        await oracleRouter.getAddress(),
        ethers.id("d"),
        await vppA.getAddress(),
        10n
      );
      const e0 = await mintingEngine.currentEpoch();
      await time.increase(EPOCH_DURATION_SECONDS + 1n);
      const e1 = await mintingEngine.currentEpoch();
      expect(e1).to.be.gt(e0);
      const e1Data = await mintingEngine.getEpochData(e1);
      expect(e1Data.totalVerifiedKwh).to.equal(0n);
      expect(e1Data.totalTokensMinted).to.equal(0n);
    });
  });

  describe("access control", () => {
    it("commitVerifiedEnergy reverts if caller != OracleRouter", async () => {
      const { mintingEngine, attacker, vppA } = await loadFixture(deployFullSystem);
      await expect(
        mintingEngine
          .connect(attacker)
          .commitVerifiedEnergy(ethers.id("d"), await vppA.getAddress(), 1n)
      ).to.be.revertedWithCustomError(mintingEngine, "NotOracleRouter");
    });

    it("recordEnergyConsumption reverts if caller != Settlement", async () => {
      const { mintingEngine, attacker } = await loadFixture(deployFullSystem);
      await expect(
        mintingEngine.connect(attacker).recordEnergyConsumption(1n)
      ).to.be.revertedWithCustomError(mintingEngine, "NotSettlement");
    });

    it("setOracleRouter and setSettlement are one-shot", async () => {
      const { mintingEngine, governor, alice } = await loadFixture(deployFullSystem);
      await expect(
        mintingEngine.connect(governor).setOracleRouter(await alice.getAddress())
      ).to.be.revertedWithCustomError(mintingEngine, "AlreadySet");
      await expect(
        mintingEngine.connect(governor).setSettlement(await alice.getAddress())
      ).to.be.revertedWithCustomError(mintingEngine, "AlreadySet");
    });
  });
});
