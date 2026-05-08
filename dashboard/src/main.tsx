import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";

import "@rainbow-me/rainbowkit/styles.css";
import "./index.css";

import App from "@/App";
import { wagmiConfig } from "@/wagmi";

/**
 * Bootstraps the dashboard.
 *
 * Provider order matters:
 *   WagmiProvider → QueryClientProvider → RainbowKitProvider → Router → App
 *
 * RainbowKit needs both wagmi + react-query in scope. The router is innermost
 * so route components can call `useAccount()` etc. without re-providers.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Most reads are cheap RPC calls; freshness over caching for the demo.
      staleTime: 12_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const rainbowTheme = darkTheme({
  accentColor: "hsl(152 56% 50%)",
  accentColorForeground: "hsl(0 0% 4%)",
  borderRadius: "medium",
  fontStack: "system",
  overlayBlur: "small",
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={rainbowTheme} modalSize="compact">
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
