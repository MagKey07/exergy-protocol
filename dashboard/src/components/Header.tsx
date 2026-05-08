import { NavLink } from "react-router-dom";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { ACTIVE_CHAIN, contractsConfigured } from "@/wagmi";

/**
 * Top chrome.
 *
 * Layout: serif logo (institutional, not "crypto-cyberpunk"), nav links,
 * network indicator + RainbowKit connect button on the right.
 *
 * Network indicator surfaces deploy status — if contract addresses aren't
 * set, observers see "contracts pending" rather than confusing zero-state.
 */
const navItems = [
  { to: "/", label: "Overview", end: true },
  { to: "/my-vpp", label: "My VPP" },
  { to: "/devices", label: "Devices" },
  { to: "/settlement", label: "Settlement" },
  { to: "/tokenomics", label: "Tokenomics" },
] as const;

export function Header(): JSX.Element {
  const { isConnected } = useAccount();
  const deployed = contractsConfigured();

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border bg-bg/80 backdrop-blur supports-[backdrop-filter]:bg-bg/60">
      <div className="mx-auto flex h-14 max-w-[1400px] items-center justify-between px-6">
        {/* Logo + Nav */}
        <div className="flex items-center gap-10">
          <NavLink to="/" className="flex items-center gap-2">
            <span
              className="font-serif text-xl tracking-[0.18em] text-fg"
              style={{ fontVariant: "small-caps" }}
            >
              EXERGY
            </span>
            <span className="hidden font-serif text-[11px] uppercase tracking-[0.22em] text-fg-subtle md:inline">
              protocol
            </span>
          </NavLink>

          <nav className="hidden items-center gap-1 md:flex">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    "rounded-md px-3 py-1.5 text-sm transition-colors",
                    isActive
                      ? "text-fg bg-surface-2"
                      : "text-fg-muted hover:text-fg hover:bg-surface-2/60",
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>

        {/* Right cluster */}
        <div className="flex items-center gap-3">
          <div className="hidden items-center gap-2 sm:flex">
            <span className="live-dot" aria-hidden />
            <span className="text-xs text-fg-muted">{ACTIVE_CHAIN.name}</span>
          </div>

          {!deployed && (
            <Badge variant="warn" className="hidden md:inline-flex">
              Contracts pending
            </Badge>
          )}

          {isConnected && (
            <Badge variant="accent" className="hidden lg:inline-flex">
              Operator session
            </Badge>
          )}

          <ConnectButton
            accountStatus={{ smallScreen: "avatar", largeScreen: "address" }}
            chainStatus="none"
            showBalance={false}
          />
        </div>
      </div>
    </header>
  );
}
