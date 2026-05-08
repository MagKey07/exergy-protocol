import { cn } from "@/lib/utils";

interface StatProps {
  label: string;
  value: React.ReactNode;
  unit?: string;
  hint?: string;
  size?: "default" | "hero";
  align?: "left" | "right";
  trend?: "up" | "down" | "flat";
  loading?: boolean;
  className?: string;
}

/**
 * Stat tile. Numbers are the hero — large monospace, hairline label above.
 * Used on Overview, MyVPP, Tokenomics. No icons, no chart-junk.
 */
export function Stat({
  label,
  value,
  unit,
  hint,
  size = "default",
  align = "left",
  loading,
  className,
}: StatProps): JSX.Element {
  return (
    <div
      className={cn(
        "panel px-5 py-4 flex flex-col gap-2",
        align === "right" && "items-end text-right",
        className,
      )}
    >
      <div className="stat-label">{label}</div>

      {loading ? (
        <div
          className={cn(
            "h-8 w-32 animate-pulse rounded bg-surface-2",
            size === "hero" && "h-14 w-48",
          )}
        />
      ) : (
        <div className="flex items-baseline gap-2">
          <span className={size === "hero" ? "stat-hero" : "stat-value"}>{value}</span>
          {unit && (
            <span className="text-xs uppercase tracking-[0.16em] text-fg-subtle">
              {unit}
            </span>
          )}
        </div>
      )}

      {hint && <div className="text-xs text-fg-subtle">{hint}</div>}
    </div>
  );
}
