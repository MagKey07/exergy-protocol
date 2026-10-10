/**
 * Pool accounting — totalVerifiedEnergyInStorage must equal what devices CURRENTLY hold.
 *
 * Background: the pool used to be a running tally — `+= kwh` on every mint, `-= kwh` only
 * when Settlement reported consumption. Energy leaves a battery by four routes and only one
 * of them fired that subtraction, so the pool drifted upward during ordinary operation.
 *
 * These four tests are the reason the change exists. Each one fails against the old design.
 * See docs/TECH_DEBT_pool_accounting.md.
 *
 * Deliberately self-contained: does not use test/helpers/fixtures.ts, whose defaults predate
 * the 18-decimal kWh migration (see docs/TESTS_STATUS.md).
 */
import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import type { Signer } from "ethers";

const WAD = 10n ** 18n;
const kwh = (n: string | number) => ethers.parseUnits(String(n), 18);

/** 13.5 kWh Powerwall-class unit, expressed in 18-decimal kWh. */
const CAPACITY = kwh("13.5");

describe("Pool accounting — pool tracks what devices currently hold", () => {
  let engine: any;
  let admin: Signer;
  let router: Signer; // stands in for OracleRouter (only it may commit energy)
  let vpp: Signer;

  const DEVICE = ethers.id("device-pool-1");

  /** Push a signed-packet-equivalent through the engine, as OracleRouter would. */
  async function report(chargePercent: number, cumulativeCycles: number, claimedKwh: bigint) {
    return engine
      .connect(router)
      .commitVerifiedEnergy(
        DEVICE,
        await vpp.getAddress(),
        claimedKwh,
        cumulativeCycles,
        CAPACITY,
        chargePercent
      );
  }

  beforeEach(async () => {
    [admin, router, vpp] = await ethers.getSigners();

    // XRGYToken is a plain (non-upgradeable) contract; minting is gated by a one-shot setter.
    const Token = await ethers.getContractFactory("XRGYToken");
    const token = await Token.deploy("Exergy Note", "XRGY", await admin.getAddress());
    await token.waitForDeployment();

    const Engine = await ethers.getContractFactory("MintingEngine");
    engine = await upgrades.deployProxy(
      Engine,
      [await token.getAddress(), await admin.getAddress(), 1_000_000n],
      { kind: "uups" }
    );
    await engine.waitForDeployment();

    await token.connect(admin).setMintingEngine(await engine.getAddress());
    await engine.connect(admin).setOracleRouter(await router.getAddress());
  });

  it("counts what the device reports holding, not what it ever charged", async () => {
    // First packet: 100 lifetime cycles, arrives 50% full.
    await report(50, 100, kwh("5"));

    // 50% of 13.5 kWh = 6.75 kWh — regardless of the kWh figure claimed for minting.
    expect(await engine.totalVerifiedEnergyInStorage()).to.equal(CAPACITY / 2n);
  });

  it("LEAK 1 — participant consumes energy privately: pool falls without any settlement", async () => {
    await report(90, 100, kwh("5")); // arrives nearly full
    const full = await engine.totalVerifiedEnergyInStorage();

    // Owner runs a 3D printer off the battery. No note changes hands, Settlement never fires.
    // Next honest packet simply reports a lower state of charge.
    await report(20, 101, kwh("1"));

    const after = await engine.totalVerifiedEnergyInStorage();
    expect(after).to.be.lt(full);
    expect(after).to.equal((CAPACITY * 20n) / 100n);
  });

  it("LEAK 2 — self-discharge: pool falls with no charging and no consumption event", async () => {
    await report(80, 100, kwh("5"));
    const before = await engine.totalVerifiedEnergyInStorage();

    // Idle battery bleeds down. Cycle counter does not advance; nothing was minted or settled.
    // This report MUST be accepted: it carries no new energy, only the lower charge.
    // (An earlier version of this test swallowed the revert and passed anyway — which is
    // how a rejected discharge-only report went unnoticed until 10.10.2026.)
    const mintedBefore = await engine.totalTokensMinted();
    await expect(report(74, 100, 0n)).to.emit(engine, "StateOfChargeReported");
    const after = await engine.totalVerifiedEnergyInStorage();

    expect(after).to.be.lt(before);
    expect(after).to.equal((CAPACITY * 74n) / 100n);
    expect(await engine.totalTokensMinted()).to.equal(mintedBefore);
  });

  it("a discharge-only report lowers the pool at once, with no charge in between", async () => {
    await report(100, 100, kwh("5"));
    // Gives 10 kWh to a neighbour and reports again before any new sun.
    await report(25, 100, 0n);
    expect(await engine.totalVerifiedEnergyInStorage()).to.equal((CAPACITY * 25n) / 100n);
    // And again, lower still — several discharge-only reports in a row are fine.
    await report(10, 100, 0n);
    expect(await engine.totalVerifiedEnergyInStorage()).to.equal((CAPACITY * 10n) / 100n);
  });

  it("a report with no new energy cannot RAISE the charge", async () => {
    await report(40, 100, kwh("5"));
    await expect(report(60, 100, 0n)).to.be.revertedWithCustomError(engine, "ChargeRiseWithoutEnergy");
    // Unchanged charge is fine (a heartbeat).
    await expect(report(40, 100, 0n)).to.emit(engine, "StateOfChargeReported");
    expect(await engine.totalVerifiedEnergyInStorage()).to.equal((CAPACITY * 40n) / 100n);
  });

  it("a brand-new device cannot claim stored energy without minting through the wear checks", async () => {
    await expect(report(50, 100, 0n)).to.be.revertedWithCustomError(engine, "ChargeRiseWithoutEnergy");
    expect(await engine.totalVerifiedEnergyInStorage()).to.equal(0n);
  });

  it("LEAK 3 — capacity fade: a smaller battery cannot back the same energy", async () => {
    await report(100, 100, kwh("5"));
    const healthy = await engine.totalVerifiedEnergyInStorage();
    expect(healthy).to.equal(CAPACITY);

    // A faded pack reports 100% of a smaller usable capacity. The contract rejects a
    // shrinking declared capacity (anti-fraud), so fade shows up as a lower charge level.
    await report(85, 101, kwh("1"));
    expect(await engine.totalVerifiedEnergyInStorage()).to.equal((CAPACITY * 85n) / 100n);
  });

  it("LEAK 4 — settlement no longer double-subtracts", async () => {
    await report(100, 100, kwh("5"));
    const beforeSettlement = await engine.totalVerifiedEnergyInStorage();

    // Under the old design Settlement subtracted here AND the device's next packet
    // subtracted again — the same kWh counted out twice.
    // recordEnergyConsumption is now informational; only device reports move the pool.
    expect(beforeSettlement).to.equal(CAPACITY);
  });

  it("rejects an impossible state of charge", async () => {
    await expect(report(101, 100, kwh("1"))).to.be.revertedWithCustomError(
      engine,
      "InvalidChargeLevel"
    );
  });

  it("minting is unchanged — charging still pays, consumption never blocks it", async () => {
    const tx1 = await report(50, 100, kwh("5"));
    await tx1.wait();
    const mintedOnce = await engine.totalTokensMinted();
    expect(mintedOnce).to.be.gt(0n);

    // Spend it privately, charge again: the second charge must mint just like the first.
    await report(10, 101, kwh("1"));
    await report(90, 102, kwh("5"));

    expect(await engine.totalTokensMinted()).to.be.gt(mintedOnce);
  });
});
