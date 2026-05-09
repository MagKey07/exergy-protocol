import { ethers } from "hardhat";
async function main() {
  const ENGINE = "0x223cEf9882f5F7528CCC4521773683B83723B5A4";
  const SETTLEMENT = "0xBaFe8D465F9D7fCab723e41c0bA13D328b2E4C9C";
  
  const engine = await ethers.getContractAt("MintingEngine", ENGINE);
  
  console.log("MintingEngine.settlement():", await engine.settlement());
  console.log("Expected (Settlement):    ", SETTLEMENT);
  console.log("MintingEngine.token():    ", await engine.token());
  console.log("MintingEngine.oracleRouter():", await engine.oracleRouter());
}
main().catch(e => { console.error(e); process.exit(1); });
