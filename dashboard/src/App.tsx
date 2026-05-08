import { Route, Routes, Navigate } from "react-router-dom";

import { Header } from "@/components/Header";
import { Overview } from "@/pages/Overview";
import { MyVPP } from "@/pages/MyVPP";
import { Devices } from "@/pages/Devices";
import { Settlement } from "@/pages/Settlement";
import { Tokenomics } from "@/pages/Tokenomics";

/**
 * Top-level layout + routing.
 *
 * Five core surfaces, each one a thin wrapper around hooks that read from
 * Arbitrum Sepolia. Phase 1 adds the operator-only registration flow and
 * the merkle-claim form; both will plug in as new routes.
 */
export default function App(): JSX.Element {
  return (
    <div className="min-h-screen bg-bg text-fg">
      <Header />
      <main className="mx-auto max-w-[1400px] px-6 py-8 lg:py-10">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/my-vpp" element={<MyVPP />} />
          <Route path="/devices" element={<Devices />} />
          <Route path="/settlement" element={<Settlement />} />
          <Route path="/tokenomics" element={<Tokenomics />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <footer className="mx-auto max-w-[1400px] px-6 py-10">
        <div className="hairline" />
        <div className="flex flex-col items-start justify-between gap-2 pt-6 text-xs text-fg-subtle sm:flex-row">
          <span>
            Exergy Protocol — Phase 0 testnet preview. Tokens are receipts for
            verified physical energy storage. No pre-mine, no token sale.
          </span>
          <span className="font-mono">Arbitrum Sepolia · ChainID 421614</span>
        </div>
      </footer>
    </div>
  );
}
