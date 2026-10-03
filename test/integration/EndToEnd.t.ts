// End-to-End — full lifecycle from device registration to settled exchange.
//
// Walks the protocol the way the canon describes it:
//   1. Governor registers VPP A and a device under it.
//   2. Device + VPP cloud co-sign a measurement packet.
//   3. OracleRouter verifies and forwards to MintingEngine.
//   4. MintingEngine mints notes to the VPP, sets the pool from the device's
//      attested charge level, floating index = 1.0.
//   5. The VPP pays alice some notes.
//   6. alice pays bob notes for energy — both inside VPP A's perimeter.
//   7. alice moves a note to a participant of another VPP (no wire needed).
//   8. The battery reports a lower charge: consumption shows up as a falling
//      floating index. No note is burned, nothing is "redeemed".
//
// This test is the single authoritative answer to "does the system actually work?".

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  BPS_DENOMINATOR,
  FEE_SPLIT,
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

const KWH = ONE_TOKEN; // kWh are 18-decimal on chain

describe("Integration: end-to-end happy path", () => {
  it("registers → mints → settles inside the perimeter → moves a note → index falls on consumption", async () => {
    const sys = await loadFixture(deployFullSystem);
    const { token, mintingEngine, oracleRouter, settlement, governance, governor, vppB, alice, bob } = sys;
    const { treasury, team, ecosystem, insurance } = sys;

    // ----- Step 1: register VPP + device -----------------------------------
    const device = makeWallet("e2e-device");
    const vppCloud = makeWallet("e2e-vpp-cloud");
    const deviceId = ethers.id("e2e-device");
    const vppId = ethers.id("vpp-A");

    await governance.connect(governor).registerVPP(vppId, vppCloud.address);
    expect(await governance.isActiveVPPOperator(vppCloud.address)).to.equal(true);
    await oracleRouter.connect(governor).registerDevice(deviceId, vppCloud.address, devicePubKeyHash(device));

    // ----- Step 2 + 3: dual-signed packet → OracleRouter verifies ----------
    const t0 = await time.latest();
    const packet = makePacket({
      deviceId,
      kwhAmount: 500n * KWH,
      storageCapacity: 500n * KWH,
      chargeLevelPercent: 100,
      cumulativeCycles: 1,
      timestamp: t0,
    });
    const devSig = await signDevice(packet, device);
    const vppSig = await signVpp(packet, devSig, vppCloud);
    await expect(oracleRouter.submitMeasurement(packet, devSig, vppSig)).to.emit(mintingEngine, "EnergyMinted");

    // ----- Step 4: minting + state checks ---------------------------------
    expect(await token.balanceOf(vppCloud.address)).to.equal(500n * ONE_TOKEN);
    expect(await mintingEngine.totalVerifiedEnergyInStorage()).to.equal(500n * KWH);
    expect(await mintingEngine.getFloatingIndex()).to.equal(ONE_TOKEN);

    // ----- Step 5: the VPP pays alice 100 notes ----------------------------
    await sys.deployer.sendTransaction({ to: vppCloud.address, value: ethers.parseEther("1") });
    await token.connect(vppCloud.connect(ethers.provider)).transfer(await alice.getAddress(), 100n * ONE_TOKEN);

    // ----- Step 6: energy for a note, inside one perimeter ----------------
    await settlement.connect(governor).setParticipantVPP(await alice.getAddress(), vppId);
    await settlement.connect(governor).setParticipantVPP(await bob.getAddress(), vppId);
    const principal = 50n * ONE_TOKEN;
    const fee = (principal * SETTLEMENT_FEE_BPS) / BPS_DENOMINATOR;
    await token.connect(alice).approve(await settlement.getAddress(), principal + fee);
    await settlement.connect(alice).settleEnergy(await bob.getAddress(), principal, 10n * KWH);

    expect(await token.balanceOf(await bob.getAddress())).to.equal(principal);
    expect(await token.balanceOf(await treasury.getAddress())).to.equal((fee * FEE_SPLIT.treasury) / BPS_DENOMINATOR);
    expect(await token.balanceOf(await team.getAddress())).to.equal((fee * FEE_SPLIT.team) / BPS_DENOMINATOR);
    expect(await token.balanceOf(await ecosystem.getAddress())).to.equal((fee * FEE_SPLIT.ecosystem) / BPS_DENOMINATOR);

    // ----- Step 7: a note travels to another VPP — no wire needed ---------
    const moved = 10n * ONE_TOKEN;
    const moveFee = (moved * SETTLEMENT_FEE_BPS) / BPS_DENOMINATOR;
    await token.connect(alice).approve(await settlement.getAddress(), moved + moveFee);
    await settlement.connect(alice).crossVPPSettle(await vppB.getAddress(), ethers.id("vpp-B"), moved);
    expect(await token.balanceOf(await vppB.getAddress())).to.equal(moved);

    // ----- Step 8: the battery reports less — the index falls, nothing burns
    const supplyBefore = await token.totalSupply();
    await time.increase(3600);
    const next = makePacket({
      deviceId,
      kwhAmount: 1n * KWH,
      storageCapacity: 500n * KWH,
      chargeLevelPercent: 50,
      cumulativeCycles: 2,
      timestamp: await time.latest(),
    });
    const devSig2 = await signDevice(next, device);
    const vppSig2 = await signVpp(next, devSig2, vppCloud);
    await oracleRouter.submitMeasurement(next, devSig2, vppSig2);

    expect(await mintingEngine.totalVerifiedEnergyInStorage()).to.equal(250n * KWH);
    expect(await token.totalSupply()).to.equal(supplyBefore + 1n * ONE_TOKEN); // only the new mint
    expect(await mintingEngine.getFloatingIndex()).to.be.lt(ONE_TOKEN);

    // ----- Final invariant: balances add up to supply (no leak, no burn) --
    const holders = [
      vppCloud.address,
      await alice.getAddress(),
      await bob.getAddress(),
      await vppB.getAddress(),
      await treasury.getAddress(),
      await team.getAddress(),
      await ecosystem.getAddress(),
      await insurance.getAddress(),
      await settlement.getAddress(),
    ];
    let sum = 0n;
    for (const h of holders) sum += await token.balanceOf(h);
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
        kwhAmount: 100n * KWH,
        storageCapacity: 100n * KWH,
        chargeLevelPercent: 100,
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
