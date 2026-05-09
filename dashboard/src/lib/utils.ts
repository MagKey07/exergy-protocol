import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { formatUnits, type Address } from "viem";

/** shadcn standard cn() helper. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Truncate a 0x address as `0x12ab…cd34`. Same convention as Etherscan.
 */
export function shortAddress(addr?: Address | string | null, head = 6, tail = 4): string {
  if (!addr) return "—";
  if (addr.length <= head + tail + 2) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

/**
 * Format a token uint256 (18 decimals) for display.
 * - Whole numbers ≥ 1000 use group separators, no decimals.
 * - Whole numbers < 1000 keep up to 4 decimals.
 * Always tabular for column alignment.
 */
export function formatToken(value: bigint | undefined, decimals = 18, opts?: { maxFrac?: number }): string {
  if (value === undefined) return "—";
  const raw = formatUnits(value, decimals);
  const num = Number(raw);
  if (!Number.isFinite(num)) return raw;
  const maxFrac = opts?.maxFrac ?? (Math.abs(num) >= 1000 ? 0 : 4);
  return num.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxFrac,
  });
}

/**
 * Format a kWh value. Contract stores kWh as 18-decimal scaled (1 kWh = 1e18 wei),
 * matching the token decimals so multiplication math stays unit-clean. Display
 * as whole kWh with up to 2 fractional digits.
 */
export function formatKwh(kwh: bigint | number | undefined): string {
  if (kwh === undefined) return "—";
  let num: number;
  if (typeof kwh === "bigint") {
    num = Number(formatUnits(kwh, 18));
  } else {
    num = kwh;
  }
  return num.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * The floating index is stored as `totalVerifiedEnergy * 1e18 / totalSupply`
 * (kWh per token, 1e18-scaled). Display as a number with 4 fractional digits.
 */
export function formatFloatingIndex(scaled?: bigint): string {
  if (scaled === undefined) return "—";
  const num = Number(formatUnits(scaled, 18));
  return num.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

/** Era rate stored as 1e18-scaled tokens-per-kWh. */
export function formatEraRate(scaled?: bigint): string {
  if (scaled === undefined) return "—";
  const num = Number(formatUnits(scaled, 18));
  if (num === 0) return "0";
  // up to 6 fractional digits — Era 5 = 0.03125
  return num.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 6 });
}

export function formatBps(bps?: bigint | number): string {
  if (bps === undefined) return "—";
  const n = typeof bps === "bigint" ? Number(bps) : bps;
  return `${(n / 100).toFixed(2)}%`;
}

export function formatTimestamp(unixSeconds?: bigint | number): string {
  if (!unixSeconds) return "—";
  const ms = Number(unixSeconds) * 1000;
  const d = new Date(ms);
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function relativeTime(unixSeconds?: bigint | number): string {
  if (!unixSeconds) return "—";
  const t = Number(unixSeconds) * 1000;
  const diff = Date.now() - t;
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Source-type enum from MeasurementPacket.sourceType. */
export const SOURCE_TYPE = ["solar", "wind", "hydro", "other"] as const;
export type SourceType = (typeof SOURCE_TYPE)[number];
export function sourceTypeLabel(s: number): SourceType {
  return SOURCE_TYPE[s] ?? "other";
}
