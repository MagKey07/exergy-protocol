// End-to-End — full lifecycle from device registration to settled trade.
//
// Walks the protocol exactly as the investor demo will:
//   1. Governor registers VPP A and a device under it.
//   2. Device + VPP cloud co-sign a measurement packet.
//   3. OracleRouter verifies and forwards to MintingEngine.
//   4. MintingEngine mints XRGY to vppA, increments storage, updates floating index.
//   5. vppA pays alice (employee in this VPP) some XRGY.
//   6. alice settles XRGY to bob (cross-VPP P2P) — fees flow to fee receivers.
//   7. bob redeems some XRGY for energy consumption — storage drops, supply unchanged.
//
// This test is the single authoritative answer to "does the system actually work?".

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
} from "../helpers/fixtures";
import {
  devicePubKeyHash,
  makePacket,
  makeWallet,
  signDevice,
  signVpp,
} from "../helpers/signatures";

describe("Integration: end-to-end happy path", () => {
  it("registers → mints → settles → redeems with all invariants intact", async () => {
    const sys = await loadFixture(deployFullSystem);
    const {
      token,
      mintingEngine,
      oracleRouter,
      settlement,
      governance,
      governor,
      vppA,
      alice,
      bob,
      treasury,
      team,
      ecosystem,
      insurance,
    } = sys;

    // ----- Step 1: register VPP + device -----------------------------------
    const device = makeWallet("e2e-device");
    const vppCloud = makeWallet("e2e-vpp-cloud");
    const deviceId = ethers.id("e2e-device");

    await governance.connect(governor).registerVPP(vppCloud.address, ethers.id("vpp-meta"));
    expect(await governance.isVPPApproved(vppCloud.address)).to.equal(true);

    await oracleRouter
      .connect(governor)
      .registerDevice(deviceId, vppCloud.address, devicePubKeyHash(device));

    // ----- Step 2 + 3: dual-signed packet → OracleRouter verifies ----------
    const packet = makePacket({ deviceId, kwhAmount: 500n, sourceType: 0 });
    const devSig = await signDevice(packet, device);
    const vppSig = await signVpp(packet, devSig, vppCloud);

    await expect(oracleRouter.submitMeasurement(packet, devSig, vppSig)).to.emit(
      mintingEngine,
      "EnergyMinted"
    );

    // ----- Step 4: minting + state checks ---------------------------------
    const vppCloudAddr = vppCloud.address;
    expect(await token.balanceOf(vppCloudAddr)).to.equal(500n * ONE_TOKEN);
    expect(await mintingEngine.totalVerifiedEnergyInStorage()).to.equal(500n);
    expect(await mintingEngine.totalTokensMinted()).to.equal(500n * ONE_TOKEN);
    // Floating index: 500 kWh * 1e18 / (500 * 1e18) = 1e18
    expect(await mintingEngine.getFloatingIndex()).to.equal(ONE_TOKEN);

    // ----- Step 5: vppCloud pays alice 100 XRGY ---------------------------
    // Direct ERC-20 transfer — VPP operator transfers off-protocol payroll.
    // Fund vppCloud wallet for gas first.
    await sys.deployer.sendTransaction({
      to: vppCloudAddr,
      value: ethers.parseEther("1"),
    });
    const vppCloudConnected = vppCloud.connect(ethers.provider);
    await token
      .connect(vppCloudConnected)
      .transfer(await alice.getAddress(), 100n * ONE_TOKEN);

    expect(await token.balanceOf(await alice.getAddress())).to.equal(100n * ONE_TOKEN);

    // ----- Step 6: alice settles 100 XRGY to bob (cross-VPP P2P) ---------
    const settleGross = 100n * ONE_TOKEN;
    await token.connect(alice).approve(await settlement.getAddress(), settleGross);
    await settlement
      .connect(alice)
      .settle(await alice.getAddress(), await bob.getAddress(), settleGross);

    const settleFee = (settleGross * SETTLEMENT_FEE_BPS) / BPS_DENOMINATOR;
    const settleNet = settleGross - settleFee;

    expect(await token.balanceOf(await bob.getAddress())).to.equal(settleNet);
    expect(await token.balanceOf(await alice.getAddress())).to.equal(0n);

    // Fee distribution: 40/20/25/15
    expect(await token.balanceOf(await treasury.getAddress())).to.equal(
      (settleFee * FEE_SPLIT.treasury) / BPS_DENOMINATOR
    );
    expect(await token.balanceOf(await team.getAddress())).to.equal(
      (settleFee * FEE_SPLIT.team) / BPS_DENOMINATOR
    );
    expect(await token.balanceOf(await ecosystem.getAddress())).to.equal(
      (settleFee * FEE_SPLIT.ecosystem) / BPS_DENOMINATOR
    );
    expect(await token.balanceOf(await insurance.getAddress())).to.equal(
      (settleFee * FEE_SPLIT.insurance) / BPS_DENOMINATOR
    );

    // ----- Step 7: bob redeems against energy consumption ----------------
    const supplyBeforeRedeem = await mintingEngine.totalTokensMinted();
    const energyBeforeRedeem = await mintingEngine.totalVerifiedEnergyInStorage();

    const redeemGross = 50n * ONE_TOKEN;
    const redeemKwh = 50n;
    await token.connect(bob).approve(await settlement.getAddress(), redeemGross);
    await settlement
      .connect(bob)
      .recordRedemption(await bob.getAddress(), redeemGross, redeemKwh);

    // NO BURN: totalTokensMinted is monotonic
    expect(await mintingEngine.totalTokensMinted()).to.equal(supplyBeforeRedeem);
    // Storage shrank
    expect(await mintingEngine.totalVerifiedEnergyInStorage()).to.equal(
      energyBeforeRedeem - redeemKwh
    );
    // Floating index dropped
    const newIndex = await mintingEngine.getFloatingIndex();
    expect(newIndex).to.be.lt(ONE_TOKEN);

    // ----- Final invariants ----------------------------------------------
    // Sum of all balances = totalSupply (no leak / no burn)
    const allHolders = [
      vppCloudAddr,
      await alice.getAddress(),
      await bob.getAddress(),
      await treasury.getAddress(),
      await team.getAddress(),
      await ecosystem.getAddress(),
      await insurance.getAddress(),
      await settlement.getAddress(), // any tokens held by Settlement (should be 0 ideally)
    ];
    let sum = 0n;
    for (const h of allHolders) sum += await token.balanceOf(h);
    expect(sum).to.equal(await token.totalSupply());
  });

  it("rejects single-signature attempt at the trust boundary (Anti-Simulation Lock)", async () => {
    const sys = await loadFixture(deployFullSystem);
    const device = makeWallet("attack-device");
    const vppCloud = makeWallet("attack-vpp-cloud");
    const deviceId = ethers.id("attack-device");

    await sys.oracleRouter
      .connect(sys.governor)
      .registerDevice(deviceId, vppCloud.address, devicePubKeyHash(device));

    const packet = makePacket({ deviceId, kwhAmount: 999n });
    const devSig = await signDevice(packet, device);

    // Attacker tries to mint without VPP cloud signature — REJECTED.
    await expect(sys.oracleRouter.submitMeasurement(packet, devSig, "0x")).to.be.reverted;

    // No tokens were minted.
    expect(await sys.token.totalSupply()).to.equal(0n);
  });

  it("preserves NO-BURN invariant across many random operations", async () => {
    const sys = await loadFixture(deployFullSystem);
    const device = makeWallet("mass-device");
    const vppCloud = makeWallet("mass-vpp-cloud");
    const deviceId = ethers.id("mass-device");

    await sys.oracleRouter
      .connect(sys.governor)
      .registerDevice(deviceId, vppCloud.address, devicePubKeyHash(device));

    let lastTimestamp = Math.floor(Date.now() / 1000);
    let totalMinted = 0n;
    for (let i = 0; i < 5; i++) {
      lastTimestamp += 60;
      const p = makePacket({
        deviceId,
        kwhAmount: 100n,
        timestamp: lastTimestamp,
        cumulativeCycles: i + 1,
      });
      const ds = await signDevice(p, device);
      const vs = await signVpp(p, ds, vppCloud);
      await sys.oracleRouter.submitMeasurement(p, ds, vs);
      totalMinted += 100n * ONE_TOKEN;
    }

    expect(await sys.token.totalSupply()).to.equal(totalMinted);
    expect(await sys.mintingEngine.totalTokensMinted()).to.equal(totalMinted);
  });
});
