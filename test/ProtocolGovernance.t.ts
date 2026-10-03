// ProtocolGovernance — VPP registry, pause, two-step ownership.
//
// Written against the deployed MVP interface (contracts/interfaces/IProtocolGovernance.sol):
//   registerVPP(bytes32 vppId, address operatorAddress) · setVPPActive(bytes32, bool)
//   getVPP(bytes32) · isActiveVPPOperator(address) · pauseProtocol / unpauseProtocol
//
// The 48h parameter timelock (Technical_Blueprint §10.3) is NOT in the MVP — the
// interface states "Production: 48-hour timelock. MVP: single owner address". Those
// tests are kept as pending so the gap stays visible instead of silently failing.

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployFullSystem } from "./helpers/fixtures";

describe("ProtocolGovernance", () => {
  describe("VPP registry", () => {
    it("registers a VPP and marks its operator active", async () => {
      const { governance, governor, vppA } = await loadFixture(deployFullSystem);
      const vppId = ethers.id("vpp-A");

      await expect(governance.connect(governor).registerVPP(vppId, await vppA.getAddress()))
        .to.emit(governance, "VPPRegistered")
        .withArgs(vppId, await vppA.getAddress());

      const rec = await governance.getVPP(vppId);
      expect(rec.operatorAddress).to.equal(await vppA.getAddress());
      expect(rec.active).to.equal(true);
      expect(await governance.isActiveVPPOperator(await vppA.getAddress())).to.equal(true);
    });

    it("setVPPActive(false) deactivates the operator", async () => {
      const { governance, governor, vppA } = await loadFixture(deployFullSystem);
      const vppId = ethers.id("vpp-A");
      await governance.connect(governor).registerVPP(vppId, await vppA.getAddress());

      await expect(governance.connect(governor).setVPPActive(vppId, false))
        .to.emit(governance, "VPPActiveStatusChanged")
        .withArgs(vppId, false);

      expect((await governance.getVPP(vppId)).active).to.equal(false);
      expect(await governance.isActiveVPPOperator(await vppA.getAddress())).to.equal(false);
    });

    it("only the governor can register VPPs", async () => {
      const { governance, attacker, vppA } = await loadFixture(deployFullSystem);
      await expect(
        governance.connect(attacker).registerVPP(ethers.id("x"), await vppA.getAddress()),
      ).to.be.reverted;
    });
  });

  describe("Pause / Unpause (circuit breaker)", () => {
    it("can be paused and unpaused by governor", async () => {
      const { governance, governor } = await loadFixture(deployFullSystem);

      await expect(governance.connect(governor).pauseProtocol()).to.emit(governance, "Paused");
      expect(await governance.paused()).to.equal(true);

      await expect(governance.connect(governor).unpauseProtocol()).to.emit(governance, "Unpaused");
      expect(await governance.paused()).to.equal(false);
    });

    it("non-owner cannot pause", async () => {
      const { governance, attacker } = await loadFixture(deployFullSystem);
      await expect(governance.connect(attacker).pauseProtocol()).to.be.reverted;
    });
  });

  // Phase 1: timelock not implemented in the MVP — see header.
  describe.skip("Parameter change with 48h timelock", () => {
    it("queues a proposal that cannot execute before TIMELOCK_DURATION", async () => {
      const { governance, governor } = await loadFixture(deployFullSystem);
      const paramKey = ethers.id("MINT_FEE_BPS");
      const newValue = 200n; // 2% — proposed bump

      const tx = await governance.connect(governor).proposeParameterChange(paramKey, newValue);
      const receipt = await tx.wait();
      // Read the proposal id either from the return value or from the event.
      const id = await readProposalId(receipt);

      await expect(governance.connect(governor).executeParameterChange(id)).to.be.reverted;

      // Advance time to just before the timelock expiry.
      const lock = await governance.TIMELOCK_DURATION();
      await time.increase(lock - 60n);
      await expect(governance.connect(governor).executeParameterChange(id)).to.be.reverted;
    });

    it("executes after the timelock window passes", async () => {
      const { governance, governor } = await loadFixture(deployFullSystem);
      const paramKey = ethers.id("MINT_FEE_BPS");
      const newValue = 75n; // bump down

      const tx = await governance.connect(governor).proposeParameterChange(paramKey, newValue);
      const receipt = await tx.wait();
      const id = await readProposalId(receipt);

      const lock = await governance.TIMELOCK_DURATION();
      await time.increase(lock + 1n);

      await expect(governance.connect(governor).executeParameterChange(id))
        .to.emit(governance, "ParameterChangeExecuted")
        .withArgs(id, paramKey, newValue);
    });

    it("uses the spec-mandated 48h timelock in production deployments", async () => {
      // MVP testnet may use a shorter timelock for demo purposes — but it must
      // be readable on-chain so investors can verify. We assert > 0 here and
      // the docs state production = 48h.
      const { governance } = await loadFixture(deployFullSystem);
      const lock = await governance.TIMELOCK_DURATION();
      expect(lock).to.be.gt(0n);
    });
  });

  describe("Two-step ownership transfer", () => {
    it("does NOT change owner until acceptOwnership is called", async () => {
      const { governance, governor, alice } = await loadFixture(deployFullSystem);
      await governance.connect(governor).transferOwnership(await alice.getAddress());

      expect(await governance.pendingOwner()).to.equal(await alice.getAddress());
      expect(await governance.owner()).to.equal(await governor.getAddress());
    });

    it("only pendingOwner can accept", async () => {
      const { governance, governor, alice, attacker } = await loadFixture(deployFullSystem);
      await governance.connect(governor).transferOwnership(await alice.getAddress());
      await expect(governance.connect(attacker).acceptOwnership()).to.be.reverted;

      await expect(governance.connect(alice).acceptOwnership()).to.emit(
        governance,
        "OwnershipTransferred"
      );
      expect(await governance.owner()).to.equal(await alice.getAddress());
    });
  });
});

async function readProposalId(receipt: any): Promise<bigint> {
  // The contract is expected to either return the id or emit ParameterChangeProposed(uint256 id, bytes32 key, uint256 value, uint256 eta).
  const event = receipt.logs.find((l: any) => l.fragment?.name === "ParameterChangeProposed");
  if (event) return BigInt(event.args[0]);
  // Fallback: a sequential id starting at 1.
  return 1n;
}
