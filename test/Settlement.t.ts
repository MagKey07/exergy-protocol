// Settlement — P2P transfers, fees, fee distribution, NO BURN.
//
// SPEC: Technical_Blueprint.md §2.4.
// CONTRACT: contracts/Settlement.sol (committed).
// ABI used here:
//   settleEnergy(address provider, uint256 tokenAmount, uint256 kwhConsumed)
//     pulls `tokenAmount` from msg.sender to provider (NO BURN),
//     pulls `tokenAmount * settlementFeeBps / 10_000` from msg.sender to
//     Settlement and distributes (Treasury 40 / Team 20 / Ecosystem 25 / Insurance 15),
//     then if kwhConsumed > 0 calls MintingEngine.recordEnergyConsumption(kwhConsumed).
//   crossVPPSettle(address receiver, bytes32 counterpartyVPPId, uint256 tokenAmount)
//     same fee mechanics; does NOT touch totalVerifiedEnergyInStorage.
//   setFeeRecipients(FeeRecipients) — FEE_MANAGER_ROLE only.
//   feeRecipients() view — returns the current FeeRecipients struct.
//
// Critical: fee is paid ON TOP of the principal. Payer must approve
// `tokenAmount + fee`. Recipient receives full `tokenAmount`.

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  BPS_DENOMINATOR,
  ONE_TOKEN,
  SETTLEMENT_FEE_BPS,
  deployFullSystem,
} from "./helpers/fixtures";

/** Helper that mints `kwh` worth of XRGY directly to `to` via impersonating OracleRouter.
 *  After the D-7 Proof-of-Wear fix `commitVerifiedEnergy` also takes
 *  `cumulativeCycles` and `storageCapacity` — we pass values that always pass
 *  the autonomous PoW check (huge capacity, single cycle) so Settlement tests
 *  stay focused on settlement logic, not minting validation. Each call uses a
 *  unique device id so the bootstrap path (cycles=1, capacity=1TWh) accepts
 *  whatever kWh the test asks for. */
let _seedDeviceCounter = 0;
async function seedTokens(
  sys: Awaited<ReturnType<typeof deployFullSystem>>,
  to: string,
  kwh: bigint,
) {
  const oracleAddr = await sys.oracleRouter.getAddress();
  await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
  await ethers.provider.send("hardhat_setBalance", [oracleAddr, "0x56BC75E2D63100000"]);
  const oracle = await ethers.getSigner(oracleAddr);
  _seedDeviceCounter += 1;
  // Need cumulativeCycles large enough that capacity * cycles >= kwh.
  // capacity = 1 TWh (10^12 kWh), so even cumulativeCycles = 1 covers any
  // realistic seed amount in the Settlement tests.
  await sys.mintingEngine
    .connect(oracle)
    .commitVerifiedEnergy(
      ethers.id(`seed-device-${_seedDeviceCounter}`),
      to,
      kwh * ONE_TOKEN, // kWh are 18-decimal on chain; tests speak in whole kWh
      1, // cumulativeCycles
      kwh * ONE_TOKEN, // storageCapacity = what was charged → index stays 1.0 note per kWh
      100, // chargeLevelPercent — seed device reports itself full
    );
  await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);
}

const VPP_A = ethers.id("vpp-A");
const VPP_B = ethers.id("vpp-B");

/** Full system with alice and bob wired into the same VPP perimeter — the
 *  precondition for any energy-for-note settlement. */
async function deployWithPerimeter() {
  const sys = await deployFullSystem();
  await sys.settlement.connect(sys.governor).setParticipantVPP(await sys.alice.getAddress(), VPP_A);
  await sys.settlement.connect(sys.governor).setParticipantVPP(await sys.bob.getAddress(), VPP_A);
  return sys;
}

/** Compute per-bucket fee split exactly as Settlement._distributeFees does:
 *  treasury/team/ecosystem use bps math; insurance gets the rounding remainder. */
function splitFee(fee: bigint): {
  treasury: bigint;
  team: bigint;
  ecosystem: bigint;
  insurance: bigint;
} {
  // The whole settlement fee goes to the Key Energy treasury.
  return { treasury: fee, team: 0n, ecosystem: 0n, insurance: 0n };
}

/** Fee-recipient balances, so tests can assert on what one settlement added
 *  (seeding notes by minting already pays the 1% minting fee to them). */
async function recipientBalances(sys: Awaited<ReturnType<typeof deployFullSystem>>) {
  return {
    treasury: await sys.token.balanceOf(await sys.treasury.getAddress()),
    team: await sys.token.balanceOf(await sys.team.getAddress()),
    ecosystem: await sys.token.balanceOf(await sys.ecosystem.getAddress()),
    insurance: await sys.token.balanceOf(await sys.insurance.getAddress()),
  };
}

describe("Settlement", () => {
  describe("settleEnergy — intra-VPP", () => {
    it("transfers the full tokenAmount to provider; pulls fee on top to recipients", async () => {
      const sys = await loadFixture(deployWithPerimeter);
      const { token, settlement, alice, bob, treasury, team, ecosystem, insurance } = sys;

      const aliceAddr = await alice.getAddress();
      const bobAddr = await bob.getAddress();

      // Seed alice with 1100 tokens (1000 principal + headroom for 0.25% fee).
      await seedTokens(sys, aliceAddr, 1200n);

      const principal = 1000n * ONE_TOKEN;
      const fee = (principal * SETTLEMENT_FEE_BPS) / BPS_DENOMINATOR;
      const split = splitFee(fee);

      // Approve principal + fee — fee is on top, not from the principal.
      await token.connect(alice).approve(await settlement.getAddress(), principal + fee);
      const aliceBefore = await token.balanceOf(aliceAddr);
      const before = await recipientBalances(sys);

      // kwhConsumed = 0 to keep this test scoped to fee mechanics.
      await settlement.connect(alice).settleEnergy(bobAddr, principal, principal);

      // Provider Bob receives the FULL principal, not net-of-fee.
      expect(await token.balanceOf(bobAddr)).to.equal(principal);

      // Alice paid principal + fee.
      expect(await token.balanceOf(aliceAddr)).to.equal(aliceBefore - principal - fee);

      // Fee distributed.
      expect((await token.balanceOf(await treasury.getAddress())) - before.treasury).to.equal(split.treasury);
      expect((await token.balanceOf(await team.getAddress())) - before.team).to.equal(split.team);
      expect((await token.balanceOf(await ecosystem.getAddress())) - before.ecosystem).to.equal(split.ecosystem);
      expect((await token.balanceOf(await insurance.getAddress())) - before.insurance).to.equal(split.insurance);

      // Settlement contract holds nothing after distribution.
      expect(await token.balanceOf(await settlement.getAddress())).to.equal(0n);
    });

    it("emits EnergySettled with payer, provider, tokensTransferred, kwhConsumed, feePaid", async () => {
      const sys = await loadFixture(deployWithPerimeter);
      const { token, settlement, alice, bob } = sys;
      await seedTokens(sys, await alice.getAddress(), 600n);

      const principal = 500n * ONE_TOKEN;
      const fee = (principal * SETTLEMENT_FEE_BPS) / BPS_DENOMINATOR;
      await token.connect(alice).approve(await settlement.getAddress(), principal + fee);

      await expect(settlement.connect(alice).settleEnergy(await bob.getAddress(), principal, principal))
        .to.emit(settlement, "EnergySettled")
        .withArgs(await alice.getAddress(), await bob.getAddress(), principal, principal, fee);
    });

    it("reports consumption without touching the pool or burning when kwhConsumed > 0", async () => {
      const sys = await loadFixture(deployWithPerimeter);
      const { token, settlement, mintingEngine, alice, bob } = sys;

      // Seed alice; this also moves totalVerifiedEnergyInStorage up by 200 kWh.
      await seedTokens(sys, await alice.getAddress(), 200n);
      const energyBefore = await mintingEngine.totalVerifiedEnergyInStorage();
      const supplyBefore = await token.totalSupply();
      const tokensMintedBefore = await mintingEngine.totalTokensMinted();

      const principal = 100n * ONE_TOKEN;
      const fee = (principal * SETTLEMENT_FEE_BPS) / BPS_DENOMINATOR;
      await token.connect(alice).approve(await settlement.getAddress(), principal + fee);
      await expect(settlement.connect(alice).settleEnergy(await bob.getAddress(), principal, principal))
        .to.emit(mintingEngine, "EnergyConsumptionReported");

      // Since 03ddb83 the pool follows device charge-level reports only; the
      // consumption shows up in the next report, so settlement must not move it.
      expect(await mintingEngine.totalVerifiedEnergyInStorage()).to.equal(energyBefore);

      // NO BURN: totalSupply never moves down.
      expect(await token.totalSupply()).to.equal(supplyBefore);
      expect(await mintingEngine.totalTokensMinted()).to.equal(tokensMintedBefore);
    });

    it("rejects energy for a note with no kWh named (KwhRequired)", async () => {
      const sys = await loadFixture(deployWithPerimeter);
      const { token, settlement, alice, bob } = sys;
      await seedTokens(sys, await alice.getAddress(), 200n);
      const principal = 100n * ONE_TOKEN;
      const fee = (principal * SETTLEMENT_FEE_BPS) / BPS_DENOMINATOR;
      await token.connect(alice).approve(await settlement.getAddress(), principal + fee);
      await expect(settlement.connect(alice).settleEnergy(await bob.getAddress(), principal, 0n))
        .to.be.revertedWithCustomError(settlement, "KwhRequired");
    });

    it("reverts on zero provider", async () => {
      const sys = await loadFixture(deployWithPerimeter);
      const { settlement, alice } = sys;
      await seedTokens(sys, await alice.getAddress(), 10n);
      await expect(
        settlement.connect(alice).settleEnergy(ethers.ZeroAddress, ONE_TOKEN, 0n),
      ).to.be.revertedWithCustomError(settlement, "ZeroAddress");
    });

    it("reverts on zero tokenAmount", async () => {
      const { settlement, alice, bob } = await loadFixture(deployWithPerimeter);
      await expect(
        settlement.connect(alice).settleEnergy(await bob.getAddress(), 0n, 0n),
      ).to.be.revertedWithCustomError(settlement, "AmountZero");
    });

    it("reverts if Settlement is not approved for principal + fee", async () => {
      const sys = await loadFixture(deployWithPerimeter);
      const { token, settlement, alice, bob } = sys;
      await seedTokens(sys, await alice.getAddress(), 100n);
      // Approve only the principal — fee pull will fail.
      const principal = 50n * ONE_TOKEN;
      await token.connect(alice).approve(await settlement.getAddress(), principal);
      await expect(
        settlement.connect(alice).settleEnergy(await bob.getAddress(), principal, principal),
      ).to.be.reverted;
    });

    it("reverts if sender has insufficient balance for principal + fee", async () => {
      const { settlement, alice, bob } = await loadFixture(deployWithPerimeter);
      // alice has 0 XRGY.
      await expect(
        settlement.connect(alice).settleEnergy(await bob.getAddress(), ONE_TOKEN, ONE_TOKEN),
      ).to.be.reverted;
    });
  });

  describe("crossVPPSettle — cross-VPP", () => {
    it("transfers full tokenAmount to receiver and distributes fee correctly", async () => {
      const sys = await loadFixture(deployWithPerimeter);
      const { token, settlement, alice, bob, treasury, team, ecosystem, insurance } = sys;

      await seedTokens(sys, await alice.getAddress(), 1200n);

      const principal = 1000n * ONE_TOKEN;
      const fee = (principal * SETTLEMENT_FEE_BPS) / BPS_DENOMINATOR;
      const split = splitFee(fee);
      const counterpartyVPPId = ethers.id("vpp-london-east");

      await token.connect(alice).approve(await settlement.getAddress(), principal + fee);
      const before = await recipientBalances(sys);
      await settlement
        .connect(alice)
        .crossVPPSettle(await bob.getAddress(), counterpartyVPPId, principal);

      expect(await token.balanceOf(await bob.getAddress())).to.equal(principal);
      expect((await token.balanceOf(await treasury.getAddress())) - before.treasury).to.equal(split.treasury);
      expect((await token.balanceOf(await team.getAddress())) - before.team).to.equal(split.team);
      expect((await token.balanceOf(await ecosystem.getAddress())) - before.ecosystem).to.equal(split.ecosystem);
      expect((await token.balanceOf(await insurance.getAddress())) - before.insurance).to.equal(split.insurance);
    });

    it("emits CrossVPPSettled with payer, receiver, counterpartyVPPId, tokensTransferred, feePaid", async () => {
      const sys = await loadFixture(deployWithPerimeter);
      const { token, settlement, alice, bob } = sys;
      await seedTokens(sys, await alice.getAddress(), 600n);

      const principal = 500n * ONE_TOKEN;
      const fee = (principal * SETTLEMENT_FEE_BPS) / BPS_DENOMINATOR;
      const counterpartyVPPId = ethers.id("vpp-paris");

      await token.connect(alice).approve(await settlement.getAddress(), principal + fee);

      await expect(
        settlement
          .connect(alice)
          .crossVPPSettle(await bob.getAddress(), counterpartyVPPId, principal),
      )
        .to.emit(settlement, "CrossVPPSettled")
        .withArgs(
          await alice.getAddress(),
          await bob.getAddress(),
          counterpartyVPPId,
          principal,
          fee,
        );
    });

    it("does NOT touch totalVerifiedEnergyInStorage (cross-VPP routes tokens only)", async () => {
      const sys = await loadFixture(deployWithPerimeter);
      const { token, settlement, mintingEngine, alice, bob } = sys;
      await seedTokens(sys, await alice.getAddress(), 200n);
      const energyBefore = await mintingEngine.totalVerifiedEnergyInStorage();

      const principal = 100n * ONE_TOKEN;
      const fee = (principal * SETTLEMENT_FEE_BPS) / BPS_DENOMINATOR;
      await token.connect(alice).approve(await settlement.getAddress(), principal + fee);
      await settlement
        .connect(alice)
        .crossVPPSettle(await bob.getAddress(), ethers.id("vpp-x"), principal);

      // Cross-VPP transfers do not adjust energy storage — the providing VPP
      // records consumption on its own side via settleEnergy.
      expect(await mintingEngine.totalVerifiedEnergyInStorage()).to.equal(energyBefore);
    });

    it("reverts on zero receiver", async () => {
      const sys = await loadFixture(deployWithPerimeter);
      const { settlement, alice } = sys;
      await seedTokens(sys, await alice.getAddress(), 10n);
      await expect(
        settlement
          .connect(alice)
          .crossVPPSettle(ethers.ZeroAddress, ethers.id("vpp-x"), ONE_TOKEN),
      ).to.be.revertedWithCustomError(settlement, "ZeroAddress");
    });

    it("reverts on zero tokenAmount", async () => {
      const { settlement, alice, bob } = await loadFixture(deployWithPerimeter);
      await expect(
        settlement
          .connect(alice)
          .crossVPPSettle(await bob.getAddress(), ethers.id("vpp-x"), 0n),
      ).to.be.revertedWithCustomError(settlement, "AmountZero");
    });
  });

  describe("Settlement fee — 100% to the Key Energy treasury", () => {
    it("pays the whole fee to the treasury and nothing to the other addresses", async () => {
      const sys = await loadFixture(deployWithPerimeter);
      const { token, settlement, alice, bob, treasury, team, ecosystem, insurance } = sys;

      await seedTokens(sys, await alice.getAddress(), 12_000n);
      const principal = 10_000n * ONE_TOKEN;
      const fee = (principal * SETTLEMENT_FEE_BPS) / BPS_DENOMINATOR;

      await token.connect(alice).approve(await settlement.getAddress(), principal + fee);
      const before = await recipientBalances(sys);
      await settlement.connect(alice).settleEnergy(await bob.getAddress(), principal, principal);

      const treasuryBal = (await token.balanceOf(await treasury.getAddress())) - before.treasury;
      const teamBal = (await token.balanceOf(await team.getAddress())) - before.team;
      const ecosystemBal = (await token.balanceOf(await ecosystem.getAddress())) - before.ecosystem;
      const insuranceBal = (await token.balanceOf(await insurance.getAddress())) - before.insurance;

      expect(treasuryBal).to.equal(fee);
      expect(teamBal).to.equal(0n);
      expect(ecosystemBal).to.equal(0n);
      expect(insuranceBal).to.equal(0n);
      expect(await token.balanceOf(await settlement.getAddress())).to.equal(0n);
    });

    it("emits SettlementFeePaid with the treasury and the amount", async () => {
      const sys = await loadFixture(deployWithPerimeter);
      const { token, settlement, alice, bob } = sys;
      await seedTokens(sys, await alice.getAddress(), 1200n);

      const principal = 1000n * ONE_TOKEN;
      const fee = (principal * SETTLEMENT_FEE_BPS) / BPS_DENOMINATOR;
      await token.connect(alice).approve(await settlement.getAddress(), principal + fee);
      await expect(settlement.connect(alice).settleEnergy(await bob.getAddress(), principal, principal))
        .to.emit(settlement, "SettlementFeePaid")
        .withArgs(await sys.treasury.getAddress(), fee);
    });

    it("the fee rate moves only inside the 0.1–0.5% corridor", async () => {
      const { settlement, governor } = await loadFixture(deployWithPerimeter);
      for (const bad of [0n, 9n, 51n, 1000n]) {
        await expect(settlement.connect(governor).setSettlementFeeBps(bad))
          .to.be.revertedWithCustomError(settlement, "SettlementFeeOutOfCorridor")
          .withArgs(bad);
      }
      for (const ok of [10n, 25n, 50n]) {
        await settlement.connect(governor).setSettlementFeeBps(ok);
        expect(await settlement.settlementFeeBps()).to.equal(ok);
      }
    });
  });

  describe("Fee recipients — admin", () => {
    it("FEE_MANAGER_ROLE (governor) can update fee recipients", async () => {
      const { settlement, governor, alice } = await loadFixture(deployWithPerimeter);
      const target = await alice.getAddress();
      await settlement.connect(governor).setFeeRecipients({
        treasury: target,
        team: target,
        ecosystem: target,
        insurance: target,
      });
      const r = await settlement.feeRecipients();
      expect(r.treasury).to.equal(target);
      expect(r.team).to.equal(target);
      expect(r.ecosystem).to.equal(target);
      expect(r.insurance).to.equal(target);
    });

    it("non-FEE_MANAGER cannot update fee recipients", async () => {
      const { settlement, attacker, alice } = await loadFixture(deployWithPerimeter);
      await expect(
        settlement.connect(attacker).setFeeRecipients({
          treasury: await alice.getAddress(),
          team: await alice.getAddress(),
          ecosystem: await alice.getAddress(),
          insurance: await alice.getAddress(),
        }),
      ).to.be.reverted;
    });

    it("rejects zero-address recipients", async () => {
      const { settlement, governor, alice } = await loadFixture(deployWithPerimeter);
      const a = await alice.getAddress();
      await expect(
        settlement.connect(governor).setFeeRecipients({
          treasury: ethers.ZeroAddress,
          team: a,
          ecosystem: a,
          insurance: a,
        }),
      ).to.be.revertedWithCustomError(settlement, "ZeroAddress");
    });
  });

  describe("NO BURN invariant", () => {
    it("settleEnergy does NOT decrease totalSupply (compares before/after)", async () => {
      const sys = await loadFixture(deployWithPerimeter);
      const { token, settlement, alice, bob } = sys;
      await seedTokens(sys, await alice.getAddress(), 1200n);
      const supplyBefore = await token.totalSupply();

      const principal = 1000n * ONE_TOKEN;
      const fee = (principal * SETTLEMENT_FEE_BPS) / BPS_DENOMINATOR;
      await token.connect(alice).approve(await settlement.getAddress(), principal + fee);
      await settlement.connect(alice).settleEnergy(await bob.getAddress(), principal, principal);

      // Tokens are money, not coupons. Supply may only move up (via mint).
      expect(await token.totalSupply()).to.equal(supplyBefore);
    });

    it("crossVPPSettle does NOT decrease totalSupply", async () => {
      const sys = await loadFixture(deployWithPerimeter);
      const { token, settlement, alice, bob } = sys;
      await seedTokens(sys, await alice.getAddress(), 1200n);
      const supplyBefore = await token.totalSupply();

      const principal = 800n * ONE_TOKEN;
      const fee = (principal * SETTLEMENT_FEE_BPS) / BPS_DENOMINATOR;
      await token.connect(alice).approve(await settlement.getAddress(), principal + fee);
      await settlement
        .connect(alice)
        .crossVPPSettle(await bob.getAddress(), ethers.id("vpp-x"), principal);

      expect(await token.totalSupply()).to.equal(supplyBefore);
    });

    it("kwhConsumed > 0 path: no burn, pool left to the next charge-level report", async () => {
      // Reproduces the canonical "money vs coupons" assertion.
      const sys = await loadFixture(deployWithPerimeter);
      const { token, settlement, mintingEngine, alice, bob } = sys;
      await seedTokens(sys, await alice.getAddress(), 500n);
      const supplyBefore = await token.totalSupply();
      const energyBefore = await mintingEngine.totalVerifiedEnergyInStorage();

      const principal = 200n * ONE_TOKEN;
      const fee = (principal * SETTLEMENT_FEE_BPS) / BPS_DENOMINATOR;
      await token.connect(alice).approve(await settlement.getAddress(), principal + fee);
      await settlement.connect(alice).settleEnergy(await bob.getAddress(), principal, principal);

      expect(await mintingEngine.totalVerifiedEnergyInStorage()).to.equal(energyBefore);
      expect(await token.totalSupply()).to.equal(supplyBefore);
    });
  });

  describe("VPP perimeter — energy for a note only over a wire", () => {
    async function fund(sys: Awaited<ReturnType<typeof deployFullSystem>>, kwh: bigint) {
      await seedTokens(sys, await sys.alice.getAddress(), kwh);
      const principal = 10n * ONE_TOKEN;
      const fee = (principal * SETTLEMENT_FEE_BPS) / BPS_DENOMINATOR;
      await sys.token.connect(sys.alice).approve(await sys.settlement.getAddress(), principal + fee);
      return principal;
    }

    it("reverts when the provider is in a different VPP", async () => {
      const sys = await loadFixture(deployWithPerimeter);
      const principal = await fund(sys, 20n);
      await sys.settlement.connect(sys.governor).setParticipantVPP(await sys.bob.getAddress(), VPP_B);
      await expect(sys.settlement.connect(sys.alice).settleEnergy(await sys.bob.getAddress(), principal, principal))
        .to.be.revertedWithCustomError(sys.settlement, "OutsidePerimeter");
    });

    it("reverts when the payer is in no VPP at all", async () => {
      const sys = await loadFixture(deployFullSystem);
      const principal = await fund(sys, 20n);
      await expect(sys.settlement.connect(sys.alice).settleEnergy(await sys.bob.getAddress(), principal, principal))
        .to.be.revertedWithCustomError(sys.settlement, "OutsidePerimeter");
    });

    it("reverts when the provider was removed from the perimeter", async () => {
      const sys = await loadFixture(deployWithPerimeter);
      const principal = await fund(sys, 20n);
      await sys.settlement.connect(sys.governor).setParticipantVPP(await sys.bob.getAddress(), ethers.ZeroHash);
      await expect(sys.settlement.connect(sys.alice).settleEnergy(await sys.bob.getAddress(), principal, principal))
        .to.be.revertedWithCustomError(sys.settlement, "OutsidePerimeter");
    });

    it("only an admin or perimeter manager can place participants", async () => {
      const sys = await loadFixture(deployFullSystem);
      await expect(
        sys.settlement.connect(sys.alice).setParticipantVPP(await sys.alice.getAddress(), VPP_A),
      ).to.be.revertedWithCustomError(sys.settlement, "NotPerimeterManager");

      const role = await sys.settlement.PERIMETER_MANAGER_ROLE();
      await sys.settlement.connect(sys.governor).grantRole(role, await sys.vppA.getAddress());
      await expect(sys.settlement.connect(sys.vppA).setParticipantVPP(await sys.alice.getAddress(), VPP_A))
        .to.emit(sys.settlement, "ParticipantVPPSet")
        .withArgs(await sys.alice.getAddress(), VPP_A);
      expect(await sys.settlement.participantVPP(await sys.alice.getAddress())).to.equal(VPP_A);
    });

    it("settles at the floating index: notes = kWh ÷ index, within 1%", async () => {
      const sys = await loadFixture(deployWithPerimeter);
      const principal = await fund(sys, 20n); // index = 1.0 → 10 notes buy 10 kWh
      await expect(sys.settlement.connect(sys.alice).settleEnergy(await sys.bob.getAddress(), principal, principal))
        .to.emit(sys.settlement, "EnergySettled");
    });

    it("rejects a price off the index (OffIndexRate)", async () => {
      const sys = await loadFixture(deployWithPerimeter);
      const principal = await fund(sys, 20n);
      // 10 notes for 1 kWh — ten times the note's energy content.
      await expect(sys.settlement.connect(sys.alice).settleEnergy(await sys.bob.getAddress(), principal, ONE_TOKEN))
        .to.be.revertedWithCustomError(sys.settlement, "OffIndexRate");
    });

    it("accepts a quote that drifted inside the 1% band", async () => {
      const sys = await loadFixture(deployWithPerimeter);
      const principal = await fund(sys, 20n);
      const kwh = (principal * 10_050n) / 10_000n; // index moved 0.5% since the quote
      await expect(sys.settlement.connect(sys.alice).settleEnergy(await sys.bob.getAddress(), principal, kwh))
        .to.emit(sys.settlement, "EnergySettled");
    });

    it("moving a note stays open across perimeters (crossVPPSettle)", async () => {
      const sys = await loadFixture(deployFullSystem);
      const principal = await fund(sys, 20n);
      await sys.settlement.connect(sys.governor).setParticipantVPP(await sys.alice.getAddress(), VPP_A);
      await sys.settlement.connect(sys.governor).setParticipantVPP(await sys.bob.getAddress(), VPP_B);
      await sys.settlement.connect(sys.alice).crossVPPSettle(await sys.bob.getAddress(), VPP_B, principal);
      expect(await sys.token.balanceOf(await sys.bob.getAddress())).to.equal(principal);
    });
  });
});
