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
 *  a fully-signed packet for unit tests of MintingEngine in isolation.
 *
 *  After the D-7 Proof-of-Wear fix the engine also takes `cumulativeCycles` and
 *  `storageCapacity`. By default we pass values that always pass the checks
 *  (large capacity, cycle counter advancing 1 per call). Tests targeting the
 *  Proof-of-Wear logic itself use `mintAsWithCycles` below to pin them. */
const DEFAULT_BIG_CAPACITY = 10n ** 12n; // 1 TWh — never the binding constraint in halving math tests.

async function mintAs(
  mintingEngine: any,
  oracleRouterAddr: string,
  deviceId: string,
  vppAddress: string,
  kwh: bigint
) {
  // Read current device state to advance cumulativeCycles by 1 each call (always within cap).
  const state = await mintingEngine.getDeviceCycleState(deviceId);
  const nextCycles = Number(state.lastCumulativeCycles) + 1;
  return mintAsWithCycles(
    mintingEngine,
    oracleRouterAddr,
    deviceId,
    vppAddress,
    kwh,
    nextCycles,
    DEFAULT_BIG_CAPACITY
  );
}

async function mintAsWithCycles(
  mintingEngine: any,
  oracleRouterAddr: string,
  deviceId: string,
  vppAddress: string,
  kwh: bigint,
  cumulativeCycles: number,
  storageCapacity: bigint,
  /** Attested state of charge. Defaults to 100% — these tests predate pool-state
   *  accounting and only care about minting, so "device reports itself full" keeps
   *  their intent intact. See test/PoolAccounting.t.ts for the pool behaviour. */
  chargeLevelPercent: number = 100
) {
  await ethers.provider.send("hardhat_impersonateAccount", [oracleRouterAddr]);
  await ethers.provider.send("hardhat_setBalance", [
    oracleRouterAddr,
    "0x56BC75E2D63100000", // 100 ETH
  ]);
  const oracleSigner = await ethers.getSigner(oracleRouterAddr);
  const tx = await mintingEngine
    .connect(oracleSigner)
    // kWh and capacity are 18-decimal on chain; tests speak in whole kWh.
    .commitVerifiedEnergy(deviceId, vppAddress, kwh * ONE_TOKEN, cumulativeCycles, storageCapacity * ONE_TOKEN, chargeLevelPercent);
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
      // Documented contract behaviour (MintingEngine.sol header): the packet that
      // crosses the threshold is credited at the pre-halving rate; the halving
      // applies from the next packet on.
      expect(minted).to.equal(100n * ONE_TOKEN);
      const balanceBeforeNext = await token.balanceOf(await vppA.getAddress());
      await mintAs(mintingEngine, await oracleRouter.getAddress(), deviceId, await vppA.getAddress(), 100n);
      expect((await token.balanceOf(await vppA.getAddress())) - balanceBeforeNext).to.equal(50n * ONE_TOKEN);
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

    it("equals 1.0 when stored energy equals supply (in token units)", async () => {
      const { mintingEngine, oracleRouter, vppA } = await loadFixture(deployFullSystem);

      // POOL ACCOUNTING CHANGE: the pool is no longer the sum of minted kWh — it is what
      // the device reports holding (capacity × state of charge). To land the 1:1 case we
      // therefore pick a capacity and charge level that make stored energy equal the kWh
      // credited for minting, instead of relying on mint-side bookkeeping.
      // See docs/TECH_DEBT_pool_accounting.md and test/PoolAccounting.t.ts.
      const CAPACITY = 100n; // integer kWh, as this suite's helpers use throughout
      await mintAsWithCycles(
        mintingEngine,
        await oracleRouter.getAddress(),
        ethers.id("d"),
        await vppA.getAddress(),
        100n, // kWh credited → 100 tokens at era-0 rate
        1, // cumulativeCycles
        CAPACITY,
        100 // device reports itself full → stored = 100 kWh
      );

      // floatingIndex = storedEnergy * 1e18 / totalSupply(wei) = 100 * 1e18 / (100 * 1e18)
      expect(await mintingEngine.totalVerifiedEnergyInStorage()).to.equal(CAPACITY * ONE_TOKEN);
      expect(await mintingEngine.getFloatingIndex()).to.equal(ONE_TOKEN);
    });

    it("is NOT moved by recordEnergyConsumption — only device reports move the pool", async () => {
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

      // Settlement reports 30 kWh consumed (energy delivered for a note inside a
      // VPP). Notes DO NOT burn; only energy bookkeeping moves.
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

      // totalTokensMinted is monotonic — must be unchanged. (NO-BURN, unchanged.)
      expect(await mintingEngine.totalTokensMinted()).to.equal(supplyBefore);

      // POOL ACCOUNTING CHANGE: this used to assert the index dropped here. It no longer
      // does, deliberately. Energy delivered under a settlement leaves a physical battery,
      // and that battery's next signed packet reports the lower state of charge — which is
      // what moves the pool. Subtracting here as well would count the same kWh out twice.
      // See docs/TECH_DEBT_pool_accounting.md.
      expect(await mintingEngine.getFloatingIndex()).to.equal(indexBefore);
    });

    it("recordEnergyConsumption never reverts on amount — it no longer debits the pool", async () => {
      // POOL ACCOUNTING CHANGE: this used to revert with EnergyUnderflow when Settlement
      // reported more kWh than the pool held. That guard existed because the call debited
      // the pool directly. It no longer does, so there is nothing to underflow — and a
      // revert here would block a legitimate settlement over a bookkeeping artefact.
      // See docs/TECH_DEBT_pool_accounting.md.
      const { mintingEngine, settlement } = await loadFixture(deployFullSystem);
      await ethers.provider.send("hardhat_impersonateAccount", [
        await settlement.getAddress(),
      ]);
      await ethers.provider.send("hardhat_setBalance", [
        await settlement.getAddress(),
        "0x56BC75E2D63100000",
      ]);
      const settlementSigner = await ethers.getSigner(await settlement.getAddress());

      // Pool is empty; report consumption anyway. Must succeed and leave the pool at zero.
      await expect(
        mintingEngine.connect(settlementSigner).recordEnergyConsumption(1n)
      ).to.emit(mintingEngine, "EnergyConsumptionReported");
      expect(await mintingEngine.totalVerifiedEnergyInStorage()).to.equal(0n);

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
      expect(data.totalVerifiedKwh).to.equal(75n * ONE_TOKEN);
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
          .commitVerifiedEnergy(
            ethers.id("d"),
            await vppA.getAddress(),
            1n,
            1, // cumulativeCycles
            DEFAULT_BIG_CAPACITY,
            100 // chargeLevelPercent
          )
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

  // ---------------------------------------------------------------------
  // Proof-of-Wear enforcement (CONCEPT_AUDIT D-7, Blueprint §5.6)
  //
  // CORE_THESIS: Proof-of-Wear is the native Sybil resistance — the
  // contract MUST reject impossible cycle counts so the $0.10/kWh
  // hardware-degradation cost actually bites. These tests pin that
  // commitment in code.
  // ---------------------------------------------------------------------
  describe("Proof-of-Wear enforcement (D-7)", () => {
    const CAPACITY = 100n; // 100 kWh battery — realistic residential pack.
    const DEVICE = () => ethers.id("pow-device");

    it("happy path: normal cycling within MAX_CYCLES_PER_EPOCH passes", async () => {
      const { mintingEngine, oracleRouter, vppA, token } = await loadFixture(deployFullSystem);
      const deviceId = DEVICE();
      const vppAddr = await vppA.getAddress();
      const oracleAddr = await oracleRouter.getAddress();

      // Packet 1: lifetime cycles = 1, kWh = 50 (within capacity).
      await mintAsWithCycles(mintingEngine, oracleAddr, deviceId, vppAddr, 50n, 1, CAPACITY);
      // Packet 2: cycles advanced by 2 (== MAX_CYCLES_PER_EPOCH for same epoch),
      // kWh 80 (≤ capacity * 2 = 200). Should pass.
      await mintAsWithCycles(mintingEngine, oracleAddr, deviceId, vppAddr, 80n, 3, CAPACITY);

      // Both packets minted; total balance = 130 tokens (era 0, 1:1 rate).
      expect(await token.balanceOf(vppAddr)).to.equal(130n * ONE_TOKEN);
      const state = await mintingEngine.getDeviceCycleState(deviceId);
      expect(state.lastCumulativeCycles).to.equal(3);
      expect(state.storageCapacity).to.equal(CAPACITY * ONE_TOKEN);
      expect(state.initialized).to.equal(true);
    });

    it("rejects when cyclesDelta > MAX_CYCLES_PER_EPOCH within one epoch (ProofOfWearViolation)", async () => {
      const { mintingEngine, oracleRouter, vppA } = await loadFixture(deployFullSystem);
      const deviceId = DEVICE();
      const vppAddr = await vppA.getAddress();
      const oracleAddr = await oracleRouter.getAddress();

      // Bootstrap device at cycles=10.
      await mintAsWithCycles(mintingEngine, oracleAddr, deviceId, vppAddr, 50n, 10, CAPACITY);

      // Same epoch, jump cycles by 5 → delta = 5, max allowed = 2 * (0 + 1) = 2 → revert.
      await expect(
        mintAsWithCycles(mintingEngine, oracleAddr, deviceId, vppAddr, 50n, 15, CAPACITY)
      )
        .to.be.revertedWithCustomError(mintingEngine, "ProofOfWearViolation")
        .withArgs(5n, 2n);

      // The AnomalyRejected event should fire on rejection (we expect both
      // emit and revert; the emit happens *before* the revert in the same tx,
      // so on revert no event is persisted — but a successful test of revert
      // is the primary commitment). We assert revert above; here we lock in
      // that the helper signature uses the right event tag in source.
      // (Belt-and-suspenders: verifying the engine has the event in its ABI.)
      const ev = mintingEngine.interface.getEvent("AnomalyRejected");
      expect(ev).to.not.equal(undefined);
    });

    it("rejects when kwhAmount > storageCapacity * cyclesDelta (EnergyExceedsCapacity)", async () => {
      const { mintingEngine, oracleRouter, vppA } = await loadFixture(deployFullSystem);
      const deviceId = DEVICE();
      const vppAddr = await vppA.getAddress();
      const oracleAddr = await oracleRouter.getAddress();

      // Bootstrap.
      await mintAsWithCycles(mintingEngine, oracleAddr, deviceId, vppAddr, 50n, 1, CAPACITY);

      // Cycles advance by 1 (legal: 1 ≤ MAX_CYCLES_PER_EPOCH=2). But kWh = 250
      // exceeds capacity * cyclesDelta = 100 * 1 = 100. Reject.
      await expect(
        mintAsWithCycles(mintingEngine, oracleAddr, deviceId, vppAddr, 250n, 2, CAPACITY)
      )
        .to.be.revertedWithCustomError(mintingEngine, "EnergyExceedsCapacity")
        .withArgs(250n * ONE_TOKEN, 100n * ONE_TOKEN);
    });

    it("boundary: exactly MAX_CYCLES_PER_EPOCH passes, one over rejects", async () => {
      const { mintingEngine, oracleRouter, vppA } = await loadFixture(deployFullSystem);
      const deviceId = DEVICE();
      const vppAddr = await vppA.getAddress();
      const oracleAddr = await oracleRouter.getAddress();

      // Bootstrap at cycles=10.
      await mintAsWithCycles(mintingEngine, oracleAddr, deviceId, vppAddr, 50n, 10, CAPACITY);

      // Exactly 2 cycles in same epoch — boundary value, must pass.
      // cyclesDelta = 2, max = 2 * (0 + 1) = 2.
      // kWh = 100 = capacity * 2 → also exactly at boundary, must pass.
      // (Boundary check is non-strict: ≤ allowed, ≤ capacity*delta).
      await mintAsWithCycles(mintingEngine, oracleAddr, deviceId, vppAddr, 100n, 12, CAPACITY);

      // Try to push one more cycle in the same epoch — cyclesDelta would be 1 over
      // a fresh epoch, but we're still in the same epoch as last packet → max
      // allowed for THIS epoch already exhausted is 2 cycles from cycles=10. Now
      // we've moved to cycles=12 with epochsDelta=0 → max=2; one more cycle would
      // require us to send cumulativeCycles=15 → delta=3 > 2. Reject.
      await expect(
        mintAsWithCycles(mintingEngine, oracleAddr, deviceId, vppAddr, 50n, 15, CAPACITY)
      )
        .to.be.revertedWithCustomError(mintingEngine, "ProofOfWearViolation")
        .withArgs(3n, 2n);

      // Now wait an epoch and the budget refreshes: max = 2 * (1 + 1) = 4.
      // From cycles=12 to cycles=16 is delta=4, which is at the new boundary → passes.
      await time.increase(EPOCH_DURATION_SECONDS + 1n);
      await mintAsWithCycles(mintingEngine, oracleAddr, deviceId, vppAddr, 200n, 16, CAPACITY);

      // Try to push too aggressive *across* this fresh epoch — last packet at
      // epoch 1 with cycles=16, same epoch resubmit with cycles=20 → delta=4,
      // max = 2 * (0 + 1) = 2 → revert (the prior call exhausted the
      // multi-epoch budget, the current epoch has only 2 cycles to spare).
      await expect(
        mintAsWithCycles(mintingEngine, oracleAddr, deviceId, vppAddr, 50n, 20, CAPACITY)
      )
        .to.be.revertedWithCustomError(mintingEngine, "ProofOfWearViolation")
        .withArgs(4n, 2n);
    });

    it("MAX_CYCLES_PER_EPOCH constant is exposed and equals 2 (autonomous, no setter)", async () => {
      const { mintingEngine } = await loadFixture(deployFullSystem);
      expect(await mintingEngine.MAX_CYCLES_PER_EPOCH()).to.equal(2n);
      // No `setMaxCyclesPerEpoch` exists — this is a sanity check via the ABI.
      // If anyone adds an admin setter, this test won't fail directly, but the
      // CONCEPT_AUDIT will catch it. Author note: D-7 mandates autonomous-only.
      const fragments = mintingEngine.interface.fragments
        .filter((f: any) => f.type === "function")
        .map((f: any) => f.name);
      expect(fragments).to.not.include("setMaxCyclesPerEpoch");
      expect(fragments).to.not.include("adminSetMaxCyclesPerEpoch");
    });
  });
});
