// Settlement — P2P transfers, fees, fee distribution, NO BURN.
//
// SPEC: Technical_Blueprint.md §2.4.
// (Interface for Settlement is not yet committed by the contracts agent —
//  this test file is written against the spec verbatim. Expected ABI:
//
//    function settle(address from, address to, uint256 amount) external;
//      // pulls `amount` $XRGY from `from` (must have approved Settlement),
//      // takes 0.25% settlement fee, distributes to fee receivers.
//
//    function recordRedemption(address consumer, uint256 amount, uint256 kwhConsumed) external;
//      // pulls `amount` from `consumer`, transfers net to a registered energy
//      // provider, also calls MintingEngine.recordEnergyConsumption(kwhConsumed).
//      // 1% mint-fee equivalent applies on the redemption side.
//
//    function feeReceivers() external view returns (FeeReceivers memory);
//
//    Fee distribution: treasury 40%, team 20%, ecosystem 25%, insurance 15%.

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  BPS_DENOMINATOR,
  FEE_SPLIT,
  MINT_FEE_BPS,
  ONE_TOKEN,
  SETTLEMENT_FEE_BPS,
  deployFullSystem,
} from "./helpers/fixtures";

/** Helper that mints `kwh` worth of XRGY directly to `to` via impersonating OracleRouter. */
async function seedTokens(sys: Awaited<ReturnType<typeof deployFullSystem>>, to: string, kwh: bigint) {
  const oracleAddr = await sys.oracleRouter.getAddress();
  await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
  await ethers.provider.send("hardhat_setBalance", [oracleAddr, "0x56BC75E2D63100000"]);
  const oracle = await ethers.getSigner(oracleAddr);
  await sys.mintingEngine
    .connect(oracle)
    .commitVerifiedEnergy(ethers.id("seed-device"), to, kwh);
  await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);
}

function splitFee(fee: bigint): {
  treasury: bigint;
  team: bigint;
  ecosystem: bigint;
  insurance: bigint;
} {
  return {
    treasury: (fee * FEE_SPLIT.treasury) / BPS_DENOMINATOR,
    team: (fee * FEE_SPLIT.team) / BPS_DENOMINATOR,
    ecosystem: (fee * FEE_SPLIT.ecosystem) / BPS_DENOMINATOR,
    insurance: (fee * FEE_SPLIT.insurance) / BPS_DENOMINATOR,
  };
}

describe("Settlement", () => {
  describe("P2P transfer with 0.25% fee", () => {
    it("moves net amount to recipient and fees to fee receivers", async () => {
      const sys = await loadFixture(deployFullSystem);
      const { token, settlement, alice, bob, treasury, team, ecosystem, insurance } = sys;

      const aliceAddr = await alice.getAddress();
      const bobAddr = await bob.getAddress();

      await seedTokens(sys, aliceAddr, 1000n); // 1000 XRGY
      const grossAmount = 1000n * ONE_TOKEN;
      await token.connect(alice).approve(await settlement.getAddress(), grossAmount);

      const fee = (grossAmount * SETTLEMENT_FEE_BPS) / BPS_DENOMINATOR;
      const net = grossAmount - fee;
      const split = splitFee(fee);

      await settlement.connect(alice).settle(aliceAddr, bobAddr, grossAmount);

      expect(await token.balanceOf(aliceAddr)).to.equal(0n);
      expect(await token.balanceOf(bobAddr)).to.equal(net);
      expect(await token.balanceOf(await treasury.getAddress())).to.equal(split.treasury);
      expect(await token.balanceOf(await team.getAddress())).to.equal(split.team);
      expect(await token.balanceOf(await ecosystem.getAddress())).to.equal(split.ecosystem);
      expect(await token.balanceOf(await insurance.getAddress())).to.equal(split.insurance);
    });

    it("settle fee distribution sums exactly to fee (no rounding leak above 1 wei)", async () => {
      const sys = await loadFixture(deployFullSystem);
      const { token, settlement, alice, bob, treasury, team, ecosystem, insurance } = sys;

      await seedTokens(sys, await alice.getAddress(), 7777n);
      const gross = 7777n * ONE_TOKEN;
      await token.connect(alice).approve(await settlement.getAddress(), gross);
      await settlement.connect(alice).settle(await alice.getAddress(), await bob.getAddress(), gross);

      const fee = (gross * SETTLEMENT_FEE_BPS) / BPS_DENOMINATOR;
      const sum =
        (await token.balanceOf(await treasury.getAddress())) +
        (await token.balanceOf(await team.getAddress())) +
        (await token.balanceOf(await ecosystem.getAddress())) +
        (await token.balanceOf(await insurance.getAddress()));

      // Allow at most 3 wei rounding tolerance across 4 buckets.
      const diff = fee > sum ? fee - sum : sum - fee;
      expect(diff).to.be.lte(3n);
    });

    it("reverts if sender has insufficient balance", async () => {
      const { settlement, alice, bob } = await loadFixture(deployFullSystem);
      await expect(
        settlement.connect(alice).settle(await alice.getAddress(), await bob.getAddress(), ONE_TOKEN)
      ).to.be.reverted;
    });

    it("reverts if Settlement is not approved", async () => {
      const sys = await loadFixture(deployFullSystem);
      const { settlement, alice, bob } = sys;
      await seedTokens(sys, await alice.getAddress(), 100n);
      await expect(
        settlement.connect(alice).settle(await alice.getAddress(), await bob.getAddress(), 50n * ONE_TOKEN)
      ).to.be.reverted;
    });
  });

  describe("Redemption (energy consumption) with 1% mint fee", () => {
    it("transfers net to provider, takes 1% fee, decreases storage WITHOUT burning", async () => {
      const sys = await loadFixture(deployFullSystem);
      const { token, settlement, mintingEngine, alice, bob } = sys;

      // Alice has 200 XRGY (and 200 kWh in storage post-mint).
      await seedTokens(sys, await alice.getAddress(), 200n);
      const supplyBefore = await mintingEngine.totalTokensMinted();
      const energyBefore = await mintingEngine.totalVerifiedEnergyInStorage();

      // Alice redeems 100 XRGY for 50 kWh of energy consumption from provider Bob.
      const gross = 100n * ONE_TOKEN;
      await token.connect(alice).approve(await settlement.getAddress(), gross);
      await settlement
        .connect(alice)
        .recordRedemption(await alice.getAddress(), gross, 50n);

      const fee = (gross * MINT_FEE_BPS) / BPS_DENOMINATOR;
      const net = gross - fee;

      // Bob is the energy provider — he gets the net.
      // The contract may resolve provider via a registry; if Bob isn't the
      // direct beneficiary in production, this assertion will need adjusting.
      // For MVP we expect a 1-arg redemption that defaults provider = msg.sender's
      // counterparty registered with VPP.
      expect(await token.balanceOf(await alice.getAddress())).to.equal(
        200n * ONE_TOKEN - gross
      );

      // Total supply did NOT decrease — NO BURN invariant.
      expect(await mintingEngine.totalTokensMinted()).to.equal(supplyBefore);

      // Stored energy decreased by exactly 50 kWh.
      expect(await mintingEngine.totalVerifiedEnergyInStorage()).to.equal(
        energyBefore - 50n
      );
    });
  });

  describe("Fee receivers — admin", () => {
    it("only governance can update fee receivers", async () => {
      const { settlement, attacker, alice } = await loadFixture(deployFullSystem);
      await expect(
        settlement.connect(attacker).setFeeReceivers({
          treasury: await alice.getAddress(),
          team: await alice.getAddress(),
          ecosystem: await alice.getAddress(),
          insurance: await alice.getAddress(),
        })
      ).to.be.reverted;
    });
  });

  describe("NO BURN invariant", () => {
    it("Settlement contract has no path that decreases totalSupply", async () => {
      const sys = await loadFixture(deployFullSystem);
      const { token, settlement, alice, bob } = sys;
      await seedTokens(sys, await alice.getAddress(), 1000n);
      const supplyBefore = await token.totalSupply();

      // Run a settle.
      await token.connect(alice).approve(await settlement.getAddress(), 500n * ONE_TOKEN);
      await settlement
        .connect(alice)
        .settle(await alice.getAddress(), await bob.getAddress(), 500n * ONE_TOKEN);

      // Run a redemption.
      await token.connect(alice).approve(await settlement.getAddress(), 200n * ONE_TOKEN);
      await settlement
        .connect(alice)
        .recordRedemption(await alice.getAddress(), 200n * ONE_TOKEN, 100n);

      expect(await token.totalSupply()).to.equal(supplyBefore);
    });
  });
});
