// Applies the mint split (18.10.2026) on a deployed network:
//   1. deploys InsuranceReserve (holds 1% of every mint; RELEASER_ROLE = admin until governance exists);
//   2. points Settlement.feeRecipients().insurance at the reserve (treasury stays the Key Energy wallet);
//   3. starts the mint-share schedule (10% for four years, then 5%) at the current block time — once only.
// Usage: npx hardhat run --network arbitrumSepolia scripts/apply-mint-split.ts
import fs from "fs";
import path from "path";
import { ethers, network } from "hardhat";

async function main() {
  const file = path.resolve(__dirname, `../deployments/${network.name}.json`);
  const book = JSON.parse(fs.readFileSync(file, "utf-8"));
  const [admin] = await ethers.getSigners();
  const settlement = await ethers.getContractAt("Settlement", book.contracts.Settlement);
  const engine = await ethers.getContractAt("MintingEngine", book.contracts.MintingEngine);

  let reserveAddr: string = book.contracts.InsuranceReserve;
  if (!reserveAddr) {
    const Reserve = await ethers.getContractFactory("InsuranceReserve");
    const reserve = await Reserve.deploy(book.contracts.XRGYToken, admin.address);
    await reserve.waitForDeployment();
    reserveAddr = await reserve.getAddress();
    book.contracts.InsuranceReserve = reserveAddr;
    fs.writeFileSync(file, JSON.stringify(book, null, 2));
    console.log("InsuranceReserve deployed:", reserveAddr);
  } else {
    console.log("InsuranceReserve already deployed:", reserveAddr);
  }

  const r = await settlement.feeRecipients();
  if (r.insurance.toLowerCase() !== reserveAddr.toLowerCase()) {
    await (await settlement.setFeeRecipients({
      treasury: r.treasury,
      team: r.team,
      ecosystem: r.ecosystem,
      insurance: reserveAddr,
    })).wait();
    console.log("Settlement insurance recipient → reserve");
  }

  if ((await engine.mintShareStart()) === 0n) {
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await (await engine.setMintShareStart(now)).wait();
    console.log("mintShareStart set:", now, new Date(now * 1000).toISOString());
  }

  const after = await settlement.feeRecipients();
  console.log("treasury:", after.treasury);
  console.log("insurance:", after.insurance);
  console.log("keyShareBps:", await engine.keyShareBps(), "mintShareStart:", await engine.mintShareStart());
  console.log("settlementFeeBps:", await settlement.settlementFeeBps());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
