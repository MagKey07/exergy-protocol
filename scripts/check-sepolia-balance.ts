import { ethers } from "hardhat";

async function main() {
  const [signer] = await ethers.getSigners();
  const addr = await signer.getAddress();
  const bal = await ethers.provider.getBalance(addr);
  const net = await ethers.provider.getNetwork();
  console.log("Deployer address:", addr);
  console.log("Balance:", ethers.formatEther(bal), "ETH");
  console.log("Chain ID:", net.chainId.toString());
  console.log("Network:", net.name);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
