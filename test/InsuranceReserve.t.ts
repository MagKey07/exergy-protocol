// InsuranceReserve — receives 1% of every mint; releases only by RELEASER_ROLE, with a reason.
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { ONE_TOKEN, RESERVE_SHARE_BPS, deployFullSystem } from "./helpers/fixtures";

async function deployWithReserve() {
  const sys = await deployFullSystem();
  const Reserve = await ethers.getContractFactory("InsuranceReserve");
  const reserve = await Reserve.deploy(await sys.token.getAddress(), await sys.governor.getAddress());
  await reserve.waitForDeployment();
  // Point the mint split's insurance share at the reserve contract.
  await sys.settlement.connect(sys.governor).setFeeRecipients({
    treasury: await sys.treasury.getAddress(),
    team: await sys.team.getAddress(),
    ecosystem: await sys.ecosystem.getAddress(),
    insurance: await reserve.getAddress(),
  });
  return { ...sys, reserve };
}

async function mint(sys: Awaited<ReturnType<typeof deployWithReserve>>, kwh: bigint) {
  const oracleAddr = await sys.oracleRouter.getAddress();
  await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
  await ethers.provider.send("hardhat_setBalance", [oracleAddr, "0x56BC75E2D63100000"]);
  const oracle = await ethers.getSigner(oracleAddr);
  await sys.mintingEngine
    .connect(oracle)
    .commitVerifiedEnergy(ethers.id(`reserve-${kwh}`), await sys.vppA.getAddress(), kwh * ONE_TOKEN, 1, kwh * ONE_TOKEN, 100);
  await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);
}

describe("InsuranceReserve", () => {
  it("receives 1% of every mint", async () => {
    const sys = await loadFixture(deployWithReserve);
    await mint(sys, 200n);
    expect(await sys.reserve.balance()).to.equal((200n * ONE_TOKEN * RESERVE_SHARE_BPS) / 10_000n);
  });

  it("releases notes only by RELEASER_ROLE, with a recorded reason", async () => {
    const sys = await loadFixture(deployWithReserve);
    await mint(sys, 200n);
    const to = await sys.alice.getAddress();
    await expect(sys.reserve.connect(sys.attacker).release(to, ONE_TOKEN, "x")).to.be.reverted;
    await expect(sys.reserve.connect(sys.governor).release(to, ONE_TOKEN, "")).to.be.revertedWithCustomError(
      sys.reserve,
      "ReasonRequired",
    );
    await expect(sys.reserve.connect(sys.governor).release(to, 0n, "x")).to.be.revertedWithCustomError(
      sys.reserve,
      "AmountZero",
    );
    await expect(sys.reserve.connect(sys.governor).release(to, ONE_TOKEN, "meter failure, device 0x01"))
      .to.emit(sys.reserve, "Released")
      .withArgs(to, ONE_TOKEN, "meter failure, device 0x01");
    expect(await sys.token.balanceOf(to)).to.equal(ONE_TOKEN);
    expect(await sys.reserve.balance()).to.equal(ONE_TOKEN);
  });

  it("rejects zero addresses at deployment", async () => {
    const Reserve = await ethers.getContractFactory("InsuranceReserve");
    const [a] = await ethers.getSigners();
    await expect(Reserve.deploy(ethers.ZeroAddress, await a.getAddress())).to.be.revertedWithCustomError(
      Reserve,
      "ZeroAddress",
    );
  });
});
