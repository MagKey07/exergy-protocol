/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ARBITRUM_SEPOLIA_RPC: string;
  readonly VITE_XRGY_TOKEN_ADDRESS: string;
  readonly VITE_MINTING_ENGINE_ADDRESS: string;
  readonly VITE_ORACLE_ROUTER_ADDRESS: string;
  readonly VITE_SETTLEMENT_ADDRESS: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID: string;
  readonly VITE_DEMO_MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
