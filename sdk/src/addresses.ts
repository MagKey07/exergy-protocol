/**
 * Live deployment addresses across networks.
 *
 * Add a new entry per network as the protocol expands. Phase 0 is
 * Arbitrum Sepolia only; mainnet (Arbitrum One) launches post-audit
 * and will be added with a fresh deploy block.
 */

export interface NetworkDeployment {
  chainId: number;
  rpcUrl: string;
  explorer: string;
  contracts: {
    xrgyToken: string;
    mintingEngine: string;
    oracleRouter: string;
    settlement: string;
    protocolGovernance: string;
  };
  deployBlock: bigint;
}

export const ARBITRUM_SEPOLIA: NetworkDeployment = {
  chainId: 421614,
  rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
  explorer: "https://sepolia.arbiscan.io",
  contracts: {
    xrgyToken: "0x8557e39A372FAC1811b2171207B669975B648fDB",
    mintingEngine: "0x223cEf9882f5F7528CCC4521773683B83723B5A4",
    oracleRouter: "0x43F2c96AE8f866C181b4ce97966Bd4e4a36AE2e5",
    settlement: "0xBaFe8D465F9D7fCab723e41c0bA13D328b2E4C9C",
    protocolGovernance: "0x6444902f410aFd866BDA058d64C596ad4Aa1ad70",
  },
  deployBlock: 266836628n,
};

export function deploymentForChain(chainId: number): NetworkDeployment {
  if (chainId === ARBITRUM_SEPOLIA.chainId) return ARBITRUM_SEPOLIA;
  throw new Error(
    `No Exergy deployment registered for chainId ${chainId}. ` +
      `Phase 0 is Arbitrum Sepolia only (chainId 421614).`,
  );
}
