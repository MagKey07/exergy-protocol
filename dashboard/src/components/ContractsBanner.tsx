import { contractsConfigured } from "@/wagmi";
import { Badge } from "@/components/ui/badge";

/**
 * Surfaces a top-of-page banner when the contracts agent has not yet wired
 * deployed addresses into VITE_*_ADDRESS env vars. Lets observers see the
 * design without confusing them with constant "0" reads.
 */
export function ContractsBanner(): JSX.Element | null {
  if (contractsConfigured()) return null;
  return (
    <div className="panel mb-6 flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <Badge variant="warn">Phase 0</Badge>
        <div>
          <div className="text-sm font-medium text-fg">
            Testnet contracts not yet wired
          </div>
          <div className="text-xs text-fg-muted">
            Numbers below render once <code className="font-mono text-fg">VITE_*_ADDRESS</code>{" "}
            entries point to the Arbitrum Sepolia deployment.
          </div>
        </div>
      </div>
    </div>
  );
}
