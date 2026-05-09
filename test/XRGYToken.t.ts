// XRGYToken — ERC-20 + ERC-2612 + mint restriction tests.
//
// SPEC: contracts/interfaces/IXRGYToken.sol + Technical_Blueprint.md §2.1.
//
// Invariants asserted here:
//   1. Standard ERC-20 surface works (transfer, approve, transferFrom, balances).
//   2. ERC-2612 permit (gasless approvals) works and rejects bad signatures.
//   3. Only the bound MintingEngine can call mint().
//   4. setMintingEngine() is one-shot (cannot be rebound).
//   5. There is NO burn function (interface check). Tokens are money, not coupons.

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployTokenOnly, ONE_TOKEN } from "./helpers/fixtures";

describe("XRGYToken", () => {
  describe("metadata", () => {
    it("has name Exergy and symbol XRGY", async () => {
      const { token } = await loadFixture(deployTokenOnly);
      expect(await token.name()).to.equal("Exergy");
      expect(await token.symbol()).to.equal("XRGY");
    });

    it("uses 18 decimals (ERC-20 default)", async () => {
      const { token } = await loadFixture(deployTokenOnly);
      expect(await token.decimals()).to.equal(18);
    });

    it("starts with zero total supply (no pre-mine — see CORE_THESIS)", async () => {
      const { token } = await loadFixture(deployTokenOnly);
      expect(await token.totalSupply()).to.equal(0n);
    });
  });

  describe("mint restriction", () => {
    it("only the bound MintingEngine can mint", async () => {
      const { token, fakeEngine, alice, attacker } = await loadFixture(deployTokenOnly);

      // fakeEngine plays the MintingEngine — wired by the fixture.
      await expect(token.connect(fakeEngine).mint(await alice.getAddress(), ONE_TOKEN))
        .to.emit(token, "Transfer")
        .withArgs(ethers.ZeroAddress, await alice.getAddress(), ONE_TOKEN);

      expect(await token.balanceOf(await alice.getAddress())).to.equal(ONE_TOKEN);
      expect(await token.totalSupply()).to.equal(ONE_TOKEN);

      await expect(
        token.connect(attacker).mint(await alice.getAddress(), ONE_TOKEN)
      ).to.be.revertedWithCustomError(token, "NotMintingEngine");
    });

    it("rejects mint to the zero address", async () => {
      const { token, fakeEngine } = await loadFixture(deployTokenOnly);
      await expect(
        token.connect(fakeEngine).mint(ethers.ZeroAddress, ONE_TOKEN)
      ).to.be.reverted; // OZ ERC20 throws ERC20InvalidReceiver
    });
  });

  describe("setMintingEngine — one-shot", () => {
    it("cannot be rebound after first wiring", async () => {
      const { token, alice } = await loadFixture(deployTokenOnly);
      await expect(
        token.setMintingEngine(await alice.getAddress())
      ).to.be.revertedWithCustomError(token, "MintingEngineAlreadySet");
    });

    it("rejects zero address as MintingEngine", async () => {
      // Re-deploy a fresh token so we can attempt the first wiring with zero.
      const TokenFactory = await ethers.getContractFactory("XRGYToken");
      const fresh = await TokenFactory.deploy("Exergy", "XRGY", await (await ethers.getSigners())[0].getAddress());
      await fresh.waitForDeployment();
      await expect(fresh.setMintingEngine(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        fresh,
        "ZeroAddress"
      );
    });
  });

  describe("ERC-20 transfer / approve", () => {
    it("transfers correctly, emits Transfer event", async () => {
      const { token, fakeEngine, alice, bob } = await loadFixture(deployTokenOnly);
      await token.connect(fakeEngine).mint(await alice.getAddress(), 5n * ONE_TOKEN);

      await expect(token.connect(alice).transfer(await bob.getAddress(), 2n * ONE_TOKEN))
        .to.emit(token, "Transfer")
        .withArgs(await alice.getAddress(), await bob.getAddress(), 2n * ONE_TOKEN);

      expect(await token.balanceOf(await alice.getAddress())).to.equal(3n * ONE_TOKEN);
      expect(await token.balanceOf(await bob.getAddress())).to.equal(2n * ONE_TOKEN);
    });

    it("approve + transferFrom respects allowance", async () => {
      const { token, fakeEngine, alice, bob } = await loadFixture(deployTokenOnly);
      await token.connect(fakeEngine).mint(await alice.getAddress(), 10n * ONE_TOKEN);
      await token.connect(alice).approve(await bob.getAddress(), 4n * ONE_TOKEN);
      expect(await token.allowance(await alice.getAddress(), await bob.getAddress())).to.equal(
        4n * ONE_TOKEN
      );

      await token
        .connect(bob)
        .transferFrom(await alice.getAddress(), await bob.getAddress(), 3n * ONE_TOKEN);

      expect(await token.balanceOf(await bob.getAddress())).to.equal(3n * ONE_TOKEN);
      expect(await token.allowance(await alice.getAddress(), await bob.getAddress())).to.equal(
        1n * ONE_TOKEN
      );
    });

    it("reverts transferFrom if allowance is insufficient", async () => {
      const { token, fakeEngine, alice, bob } = await loadFixture(deployTokenOnly);
      await token.connect(fakeEngine).mint(await alice.getAddress(), 10n * ONE_TOKEN);
      await token.connect(alice).approve(await bob.getAddress(), 1n * ONE_TOKEN);

      await expect(
        token
          .connect(bob)
          .transferFrom(await alice.getAddress(), await bob.getAddress(), 5n * ONE_TOKEN)
      ).to.be.reverted; // ERC20InsufficientAllowance
    });

    it("reverts transfer if balance is insufficient", async () => {
      const { token, alice, bob } = await loadFixture(deployTokenOnly);
      await expect(
        token.connect(alice).transfer(await bob.getAddress(), 1n)
      ).to.be.reverted; // ERC20InsufficientBalance
    });
  });

  describe("ERC-2612 permit (gasless approval)", () => {
    it("accepts a valid signed permit", async () => {
      const { token, fakeEngine, alice, bob } = await loadFixture(deployTokenOnly);
      await token.connect(fakeEngine).mint(await alice.getAddress(), 10n * ONE_TOKEN);

      const owner = await alice.getAddress();
      const spender = await bob.getAddress();
      const value = 5n * ONE_TOKEN;
      const nonce = await token.nonces(owner);
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600;

      const network = await ethers.provider.getNetwork();
      const domain = {
        name: "Exergy",
        version: "1",
        chainId: network.chainId,
        verifyingContract: await token.getAddress(),
      };
      const types = {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      };
      const values = { owner, spender, value, nonce, deadline };
      const sig = await alice.signTypedData(domain, types, values);
      const { v, r, s } = ethers.Signature.from(sig);

      await token.permit(owner, spender, value, deadline, v, r, s);
      expect(await token.allowance(owner, spender)).to.equal(value);
      expect(await token.nonces(owner)).to.equal(nonce + 1n);
    });

    it("rejects expired permits", async () => {
      const { token, alice, bob } = await loadFixture(deployTokenOnly);
      const owner = await alice.getAddress();
      const spender = await bob.getAddress();
      const past = (await ethers.provider.getBlock("latest"))!.timestamp - 1;
      // Any signature works here — contract should reject by deadline first.
      await expect(
        token.permit(owner, spender, 1n, past, 27, ethers.ZeroHash, ethers.ZeroHash)
      ).to.be.reverted;
    });

    it("rejects mismatched signer", async () => {
      const { token, alice, bob, attacker } = await loadFixture(deployTokenOnly);

      const owner = await alice.getAddress();
      const spender = await bob.getAddress();
      const value = 1n * ONE_TOKEN;
      const nonce = await token.nonces(owner);
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600;

      const network = await ethers.provider.getNetwork();
      const domain = {
        name: "Exergy",
        version: "1",
        chainId: network.chainId,
        verifyingContract: await token.getAddress(),
      };
      const types = {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      };
      const values = { owner, spender, value, nonce, deadline };
      // Attacker (not owner) signs — must be rejected.
      const sig = await attacker.signTypedData(domain, types, values);
      const { v, r, s } = ethers.Signature.from(sig);

      await expect(token.permit(owner, spender, value, deadline, v, r, s)).to.be.reverted;
    });
  });

  describe("NO burn (CORE_THESIS invariant)", () => {
    it("does not expose any burn / burnFrom function", async () => {
      const { token } = await loadFixture(deployTokenOnly);
      // OZ ERC20Burnable would expose `burn(uint256)` and `burnFrom(address,uint256)`.
      // Both must be absent — hence calling them should throw at the JS level.
      expect((token as any).burn).to.be.undefined;
      expect((token as any).burnFrom).to.be.undefined;
    });
  });
});
