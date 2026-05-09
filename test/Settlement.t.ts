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
  FEE_SPLIT,
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
      kwh,
      1, // cumulativeCycles
      10n ** 12n, // storageCapacity = 1 TWh
    );
  await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);
}

/** Compute per-bucket fee split exactly as Settlement._distributeFees does:
 *  treasury/team/ecosystem use bps math; insurance gets the rounding remainder. */
function splitFee(fee: bigint): {
  treasury: bigint;
  team: bigint;
  ecosystem: bigint;
  insurance: bigint;
} {
  const treasury = (fee * FEE_SPLIT.treasury) / BPS_DENOMINATOR;
  const team = (fee * FEE_SPLIT.team) / BPS_DENOMINATOR;
  const ecosystem = (fee * FEE_SPLIT.ecosystem) / BPS_DENOMINATOR;
  const insurance = fee - treasury - team - ecosystem;
  return { treasury, team, ecosystem, insurance };
}

describe("Settlement", () => {
  describe("settleEnergy — intra-VPP", () => {
    it("transfers the full tokenAmount to provider; pulls fee on top to recipients", async () => {
      const sys = await loadFixture(deployFullSystem);
      const { token, settlement, alice, bob, treasury, team, ecosystem, insurance } = sys;

      const aliceAddr = await alice.getAddress();
      const bobAddr = await bob.getAddress();

      // Seed alice with 1100 tokens (1000 principal + headroom for 0.25% fee).
      await seedTokens(sys, aliceAddr, 1100n);

      const principal = 1000n * ONE_TOKEN;
      const fee = (principal * SETTLEMENT_FEE_BPS) / BPS_DENOMINATOR;
      const split = splitFee(fee);

      // Approve principal + fee — fee is on top, not from the principal.
      await token.connect(alice).approve(await settlement.getAddress(), principal + fee);

      // kwhConsumed = 0 to keep this test scoped to fee mechanics.
      await settlement.connect(alice).settleEnergy(bobAddr, principal, 0n);

      // Provider Bob receives the FULL principal, not net-of-fee.
      expect(await token.balanceOf(bobAddr)).to.equal(principal);

      // Alice paid principal + fee out of her 1100-token balance.
      expect(await token.balanceOf(aliceAddr)).to.equal(1100n * ONE_TOKEN - principal - fee);

      // Fee distributed.
      expect(await token.balanceOf(await treasury.getAddress())).to.equal(split.treasury);
      expect(await token.balanceOf(await team.getAddress())).to.equal(split.team);
      expect(await token.balanceOf(await ecosystem.getAddress())).to.equal(split.ecosystem);
      expect(await token.balanceOf(await insurance.getAddress())).to.equal(split.insurance);

      // Settlement contract holds nothing after distribution.
      expect(await token.balanceOf(await settlement.getAddress())).to.equal(0n);
    });

    it("emits EnergySettled with payer, provider, tokensTransferred, kwhConsumed, feePaid", async () => {
      const sys = await loadFixture(deployFullSystem);
      const { token, settlement, alice, bob } = sys;
      await seedTokens(sys, await alice.getAddress(), 600n);

      const principal = 500n * ONE_TOKEN;
      const fee = (principal * SETTLEMENT_FEE_BPS) / BPS_DENOMINATOR;
      await token.connect(alice).approve(await settlement.getAddress(), principal + fee);

      await expect(settlement.connect(alice).settleEnergy(await bob.getAddress(), principal, 42n))
        .to.emit(settlement, "EnergySettled")
        .withArgs(await alice.getAddress(), await bob.getAddress(), principal, 42n, fee);
    });

    it("decrements totalVerifiedEnergyInStorage by kwhConsumed (no burn) when kwhConsumed > 0", async () => {
      const sys = await loadFixture(deployFullSystem);
      const { token, settlement, mintingEngine, alice, bob } = sys;

      // Seed alice; this also moves totalVerifiedEnergyInStorage up by 200 kWh.
      await seedTokens(sys, await alice.getAddress(), 200n);
      const energyBefore = await mintingEngine.totalVerifiedEnergyInStorage();
      const supplyBefore = await token.totalSupply();
      const tokensMintedBefore = await mintingEngine.totalTokensMinted();

      const principal = 100n * ONE_TOKEN;
      const fee = (principal * SETTLEMENT_FEE_BPS) / BPS_DENOMINATOR;
      await token.connect(alice).approve(await settlement.getAddress(), principal + fee);
      await settlement.connect(alice).settleEnergy(await bob.getAddress(), principal, 50n);

      // Stored energy decreased by exactly the consumed kWh — measurement, not burn.
      expect(await mintingEngine.totalVerifiedEnergyInStorage()).to.equal(energyBefore - 50n);

      // NO BURN: totalSupply never moves down.
      expect(await token.totalSupply()).to.equal(supplyBefore);
      expect(await mintingEngine.totalTokensMinted()).to.equal(tokensMintedBefore);
    });

    it("does NOT touch totalVerifiedEnergyInStorage when kwhConsumed == 0", async () => {
      const sys = await loadFixture(deployFullSystem);
      const { token, settlement, mintingEngine, alice, bob } = sys;
      await seedTokens(sys, await alice.getAddress(), 200n);
      const energyBefore = await mintingEngine.totalVerifiedEnergyInStorage();

      const principal = 100n * ONE_TOKEN;
      const fee = (principal * SETTLEMENT_FEE_BPS) / BPS_DENOMINATOR;
      await token.connect(alice).approve(await settlement.getAddress(), principal + fee);
      await settlement.connect(alice).settleEnergy(await bob.getAddress(), principal, 0n);

      expect(await mintingEngine.totalVerifiedEnergyInStorage()).to.equal(energyBefore);
    });

    it("reverts on zero provider", async () => {
      const sys = await loadFixture(deployFullSystem);
      const { settlement, alice } = sys;
      await seedTokens(sys, await alice.getAddress(), 10n);
      await expect(
        settlement.connect(alice).settleEnergy(ethers.ZeroAddress, ONE_TOKEN, 0n),
      ).to.be.revertedWithCustomError(settlement, "ZeroAddress");
    });

    it("reverts on zero tokenAmount", async () => {
      const { settlement, alice, bob } = await loadFixture(deployFullSystem);
      await expect(
        settlement.connect(alice).settleEnergy(await bob.getAddress(), 0n, 0n),
      ).to.be.revertedWithCustomError(settlement, "AmountZero");
    });

    it("reverts if Settlement is not approved for principal + fee", async () => {
      const sys = await loadFixture(deployFullSystem);
      const { token, settlement, alice, bob } = sys;
      await seedTokens(sys, await alice.getAddress(), 100n);
      // Approve only the principal — fee pull will fail.
      const principal = 50n * ONE_TOKEN;
      await token.connect(alice).approve(await settlement.getAddress(), principal);
      await expect(
        settlement.connect(alice).settleEnergy(await bob.getAddress(), principal, 0n),
      ).to.be.reverted;
    });

    it("reverts if sender has insufficient balance for principal + fee", async () => {
      const { settlement, alice, bob } = await loadFixture(deployFullSystem);
      // alice has 0 XRGY.
      await expect(
        settlement.connect(alice).settleEnergy(await bob.getAddress(), ONE_TOKEN, 0n),
      ).to.be.reverted;
    });
  });

  describe("crossVPPSettle — cross-VPP", () => {
    it("transfers full tokenAmount to receiver and distributes fee correctly", async () => {
      const sys = await loadFixture(deployFullSystem);
      const { token, settlement, alice, bob, treasury, team, ecosystem, insurance } = sys;

      await seedTokens(sys, await alice.getAddress(), 1100n);

      const principal = 1000n * ONE_TOKEN;
      const fee = (principal * SETTLEMENT_FEE_BPS) / BPS_DENOMINATOR;
      const split = splitFee(fee);
      const counterpartyVPPId = ethers.id("vpp-london-east");

      await token.connect(alice).approve(await settlement.getAddress(), principal + fee);
      await settlement
        .connect(alice)
        .crossVPPSettle(await bob.getAddress(), counterpartyVPPId, principal);

      expect(await token.balanceOf(await bob.getAddress())).to.equal(principal);
      expect(await token.balanceOf(await treasury.getAddress())).to.equal(split.treasury);
      expect(await token.balanceOf(await team.getAddress())).to.equal(split.team);
      expect(await token.balanceOf(await ecosystem.getAddress())).to.equal(split.ecosystem);
      expect(await token.balanceOf(await insurance.getAddress())).to.equal(split.insurance);
    });

    it("emits CrossVPPSettled with payer, receiver, counterpartyVPPId, tokensTransferred, feePaid", async () => {
      const sys = await loadFixture(deployFullSystem);
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
      const sys = await loadFixture(deployFullSystem);
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
      const sys = await loadFixture(deployFullSystem);
      const { settlement, alice } = sys;
      await seedTokens(sys, await alice.getAddress(), 10n);
      await expect(
        settlement
          .connect(alice)
          .crossVPPSettle(ethers.ZeroAddress, ethers.id("vpp-x"), ONE_TOKEN),
      ).to.be.revertedWithCustomError(settlement, "ZeroAddress");
    });

    it("reverts on zero tokenAmount", async () => {
      const { settlement, alice, bob } = await loadFixture(deployFullSystem);
      await expect(
        settlement
          .connect(alice)
          .crossVPPSettle(await bob.getAddress(), ethers.id("vpp-x"), 0n),
      ).to.be.revertedWithCustomError(settlement, "AmountZero");
    });
  });

  describe("Fee distribution math — 40 / 20 / 25 / 15", () => {
    it("distributes exactly per Treasury 40% / Team 20% / Ecosystem 25% / Insurance 15%", async () => {
      const sys = await loadFixture(deployFullSystem);
      const { token, settlement, alice, bob, treasury, team, ecosystem, insurance } = sys;

      await seedTokens(sys, await alice.getAddress(), 11_000n);
      const principal = 10_000n * ONE_TOKEN;
      const fee = (principal * SETTLEMENT_FEE_BPS) / BPS_DENOMINATOR;

      await token.connect(alice).approve(await settlement.getAddress(), principal + fee);
      await settlement.connect(alice).settleEnergy(await bob.getAddress(), principal, 0n);

      const treasuryBal = await token.balanceOf(await treasury.getAddress());
      const teamBal = await token.balanceOf(await team.getAddress());
      const ecosystemBal = await token.balanceOf(await ecosystem.getAddress());
      const insuranceBal = await token.balanceOf(await insurance.getAddress());

      // Treasury / Team / Ecosystem use floor bps math; Insurance gets the remainder.
      expect(treasuryBal).to.equal((fee * FEE_SPLIT.treasury) / BPS_DENOMINATOR);
      expect(teamBal).to.equal((fee * FEE_SPLIT.team) / BPS_DENOMINATOR);
      expect(ecosystemBal).to.equal((fee * FEE_SPLIT.ecosystem) / BPS_DENOMINATOR);
      expect(insuranceBal).to.equal(fee - treasuryBal - teamBal - ecosystemBal);

      // Sum is exactly the fee — no leak, no overpay.
      expect(treasuryBal + teamBal + ecosystemBal + insuranceBal).to.equal(fee);
    });

    it("emits FeesDistributed with the four bucket amounts", async () => {
      const sys = await loadFixture(deployFullSystem);
      const { token, settlement, alice, bob } = sys;
      await seedTokens(sys, await alice.getAddress(), 1100n);

      const principal = 1000n * ONE_TOKEN;
      const fee = (principal * SETTLEMENT_FEE_BPS) / BPS_DENOMINATOR;
      const split = splitFee(fee);

      await token.connect(alice).approve(await settlement.getAddress(), principal + fee);
      await expect(settlement.connect(alice).settleEnergy(await bob.getAddress(), principal, 0n))
        .to.emit(settlement, "FeesDistributed")
        .withArgs(split.treasury, split.team, split.ecosystem, split.insurance);
    });
  });

  describe("Fee recipients — admin", () => {
    it("FEE_MANAGER_ROLE (governor) can update fee recipients", async () => {
      const { settlement, governor, alice } = await loadFixture(deployFullSystem);
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
      const { settlement, attacker, alice } = await loadFixture(deployFullSystem);
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
      const { settlement, governor, alice } = await loadFixture(deployFullSystem);
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
      const sys = await loadFixture(deployFullSystem);
      const { token, settlement, alice, bob } = sys;
      await seedTokens(sys, await alice.getAddress(), 1100n);
      const supplyBefore = await token.totalSupply();

      const principal = 1000n * ONE_TOKEN;
      const fee = (principal * SETTLEMENT_FEE_BPS) / BPS_DENOMINATOR;
      await token.connect(alice).approve(await settlement.getAddress(), principal + fee);
      await settlement.connect(alice).settleEnergy(await bob.getAddress(), principal, 100n);

      // Tokens are money, not coupons. Supply may only move up (via mint).
      expect(await token.totalSupply()).to.equal(supplyBefore);
    });

    it("crossVPPSettle does NOT decrease totalSupply", async () => {
      const sys = await loadFixture(deployFullSystem);
      const { token, settlement, alice, bob } = sys;
      await seedTokens(sys, await alice.getAddress(), 1100n);
      const supplyBefore = await token.totalSupply();

      const principal = 800n * ONE_TOKEN;
      const fee = (principal * SETTLEMENT_FEE_BPS) / BPS_DENOMINATOR;
      await token.connect(alice).approve(await settlement.getAddress(), principal + fee);
      await settlement
        .connect(alice)
        .crossVPPSettle(await bob.getAddress(), ethers.id("vpp-x"), principal);

      expect(await token.totalSupply()).to.equal(supplyBefore);
    });

    it("kwhConsumed > 0 path: storage shrinks WITHOUT burning tokens", async () => {
      // Reproduces the canonical "money vs coupons" assertion.
      const sys = await loadFixture(deployFullSystem);
      const { token, settlement, mintingEngine, alice, bob } = sys;
      await seedTokens(sys, await alice.getAddress(), 500n);
      const supplyBefore = await token.totalSupply();
      const energyBefore = await mintingEngine.totalVerifiedEnergyInStorage();

      const principal = 200n * ONE_TOKEN;
      const fee = (principal * SETTLEMENT_FEE_BPS) / BPS_DENOMINATOR;
      await token.connect(alice).approve(await settlement.getAddress(), principal + fee);
      await settlement.connect(alice).settleEnergy(await bob.getAddress(), principal, 250n);

      expect(await mintingEngine.totalVerifiedEnergyInStorage()).to.equal(energyBefore - 250n);
      expect(await token.totalSupply()).to.equal(supplyBefore);
    });
  });
});
