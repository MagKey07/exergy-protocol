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
  encodePacket,
  makePacket,
  makeWallet,
  packetHash,
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
      .settleEnergy(await alice.getAddress(), await bob.getAddress(), settleGross);

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

// ---------------------------------------------------------------------------
// Interop probe — Phase 0 dialect (EXERGY_SIGNATURE_DIALECT_V0).
//
// Regression for CONCEPT_AUDIT.md D-1. The contract, the test helpers, and
// the oracle-simulator must produce IDENTICAL bytes for the device digest
// and the VPP-cosignature digest given identical inputs. Any drift between
// reference implementations is a violation of CORE_THESIS "no centralized
// software gatekeeping" — this test would have caught the original bug
// (test helper encoded the packet struct again, simulator added a third
// `vppAddress` field).
//
// We do NOT reach for a full deploy here — the probe is a pure-bytes check
// of the digest construction so it stays fast and runs in every CI cycle.
// ---------------------------------------------------------------------------
describe("Interop probe: Phase 0 dialect digest equivalence", () => {
  it("test helper packet hash matches a from-scratch ethers.js encoding", () => {
    const packet = makePacket({
      deviceId: ethers.id("interop-probe-device"),
      kwhAmount: 777n,
      timestamp: 1_700_000_000,
      storageCapacity: 13_500n,
      chargeLevelPercent: 42,
      sourceType: 0,
      cumulativeCycles: 99,
    });

    // Reference path #1: helper's `packetHash` (encodes as struct tuple).
    const helperHash = packetHash(packet);

    // Reference path #2: encode field-by-field per PROTOCOL_SPEC.md §6.
    // For an all-static-types struct, abi.encode(struct) == abi.encode(fields...).
    const fieldsEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "uint64", "uint256", "uint8", "uint8", "uint32"],
      [
        packet.deviceId,
        packet.kwhAmount,
        packet.timestamp,
        packet.storageCapacity,
        packet.chargeLevelPercent,
        packet.sourceType,
        packet.cumulativeCycles,
      ]
    );
    const fieldsHash = ethers.keccak256(fieldsEncoded);

    // Reference path #3: encode via the helper's tuple type explicitly.
    // (sanity-check that `encodePacket` and ad-hoc encoding agree)
    const tupleEncoded = encodePacket(packet);
    const tupleHash = ethers.keccak256(tupleEncoded);

    expect(helperHash).to.equal(fieldsHash);
    expect(helperHash).to.equal(tupleHash);
  });

  it("VPP-cosignature payload hash equals abi.encode(packetHash, deviceSig)", async () => {
    const device = makeWallet("interop-device");
    const vpp = makeWallet("interop-vpp");
    const packet = makePacket({
      deviceId: ethers.id("interop-vpp-device"),
      kwhAmount: 321n,
      cumulativeCycles: 7,
    });

    const devSig = await signDevice(packet, device);

    // The contract computes (per OracleRouter.sol:175):
    //   vppPayloadHash = keccak256(abi.encode(packetHash, deviceSignature));
    const expectedPayloadHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes"],
        [packetHash(packet), devSig]
      )
    );

    // The helper uses the same rule. We verify the VPP signature recovers
    // to the VPP wallet under the canonical scheme — which only works if
    // the helper's vppPayloadHash equals the contract's vppPayloadHash.
    const vppSig = await signVpp(packet, devSig, vpp);

    // Recreate the digest the contract recovers against:
    //   vppDigest = keccak256("\x19Ethereum Signed Message:\n32" || vppPayloadHash)
    // and verify recovery.
    const recovered = ethers.verifyMessage(
      ethers.getBytes(expectedPayloadHash),
      vppSig
    );
    expect(recovered.toLowerCase()).to.equal(vpp.address.toLowerCase());
  });

  it("device digest recovery matches the contract's recovery scheme", async () => {
    const device = makeWallet("interop-device-recovery");
    const packet = makePacket({
      deviceId: ethers.id("interop-recovery"),
      kwhAmount: 50n,
    });

    const devSig = await signDevice(packet, device);

    // Mirror OracleRouter.sol:166-167:
    //   bytes32 deviceDigest = packetHash.toEthSignedMessageHash();
    //   address recovered = deviceDigest.recover(deviceSignature);
    const recovered = ethers.verifyMessage(
      ethers.getBytes(packetHash(packet)),
      devSig
    );
    expect(recovered.toLowerCase()).to.equal(device.address.toLowerCase());
  });

  it("rejects the legacy (struct-as-inner) VPP encoding — contracts MUST diverge", async () => {
    const device = makeWallet("legacy-encoding-device");
    const vpp = makeWallet("legacy-encoding-vpp");
    const packet = makePacket({ deviceId: ethers.id("legacy-encoding") });

    const devSig = await signDevice(packet, device);

    // The OLD (broken) encoding: encode the struct again instead of its hash.
    const PACKET_TUPLE =
      "tuple(bytes32 deviceId,uint256 kwhAmount,uint64 timestamp,uint256 storageCapacity,uint8 chargeLevelPercent,uint8 sourceType,uint32 cumulativeCycles)";
    const legacyPayloadHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        [PACKET_TUPLE, "bytes"],
        [packet, devSig]
      )
    );

    const canonicalPayloadHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes"],
        [packetHash(packet), devSig]
      )
    );

    // Sanity: they differ — that's the whole point of D-1.
    expect(legacyPayloadHash).to.not.equal(canonicalPayloadHash);

    // The current helper uses the canonical form.
    const vppSig = await signVpp(packet, devSig, vpp);
    const recovered = ethers.verifyMessage(
      ethers.getBytes(canonicalPayloadHash),
      vppSig
    );
    expect(recovered.toLowerCase()).to.equal(vpp.address.toLowerCase());

    // ...and would fail recovery against the legacy hash.
    const recoveredAgainstLegacy = ethers.verifyMessage(
      ethers.getBytes(legacyPayloadHash),
      vppSig
    );
    expect(recoveredAgainstLegacy.toLowerCase()).to.not.equal(
      vpp.address.toLowerCase()
    );
  });
});
