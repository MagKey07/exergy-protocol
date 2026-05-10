import { useMemo } from "react";

import { PageHeader } from "@/components/PageHeader";
import { Stat } from "@/components/Stat";
import { ContractsBanner } from "@/components/ContractsBanner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useProtocolStats } from "@/hooks/useProtocolStats";
import { useFloatingIndex } from "@/hooks/useFloatingIndex";
import { useEraRate } from "@/hooks/useEraRate";
import { useMintEvents } from "@/hooks/useMintEvents";
import {
  formatToken,
  formatKwh,
  formatFloatingIndex,
  formatEraRate,
  shortAddress,
  relativeTime,
} from "@/lib/utils";

/**
 * Network-wide view. The first thing an investor or partner sees.
 *
 * Hierarchy:
 *  1. Hero: total $XRGY supply (this is the headline number).
 *  2. Three flanking stats: floating index, current era + rate, total kWh in storage.
 *  3. Recent epoch settlements feed — proves the protocol is alive.
 *  4. Active VPPs table (derived from mint event uniqueness — Phase 0 fallback
 *     until VPP registry contract event is added).
 */
export function Overview(): JSX.Element {
  const { data: stats, isLoading: statsLoading } = useProtocolStats();
  const { data: floatingIndex } = useFloatingIndex();
  const { data: era } = useEraRate();
  // We need every mint to derive cumulative-kWh + active-VPP set, but only
  // surface the most recent 12 in the feed. Fetch a wider window then slice.
  const { data: allMints, isLoading: mintsLoading } = useMintEvents({ limit: 1_000 });
  const mints = useMemo(() => allMints.slice(0, 12), [allMints]);

  // `totalEnergyEverVerified` is not exposed on-chain. Sum kwhAmount across
  // every EnergyMinted event — strictly increasing, matches the spec.
  const cumulativeKwh = useMemo(() => {
    if (allMints.length === 0) return undefined;
    return allMints.reduce<bigint>((acc, m) => acc + m.kwh, 0n);
  }, [allMints]);

  const activeVPPs = useMemo(() => {
    const map = new Map<
      string,
      { vpp: string; mints: number; lastEpoch: bigint; totalKwh: bigint; totalTokens: bigint }
    >();
    for (const m of allMints) {
      const key = m.vpp.toLowerCase();
      const existing = map.get(key);
      if (existing) {
        existing.mints += 1;
        existing.totalKwh += m.kwh;
        existing.totalTokens += m.tokens;
        if (m.epoch > existing.lastEpoch) existing.lastEpoch = m.epoch;
      } else {
        map.set(key, {
          vpp: m.vpp,
          mints: 1,
          lastEpoch: m.epoch,
          totalKwh: m.kwh,
          totalTokens: m.tokens,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => Number(b.totalTokens - a.totalTokens));
  }, [allMints]);

  return (
    <>
      <PageHeader
        eyebrow="Network"
        title="Protocol Overview"
        subtitle="Live state of the Exergy settlement layer. Every $XRGY in circulation is a receipt for verified physical energy storage. Tokens are minted only by Proof-of-Charge — never sold, never pre-mined."
      />

      <ContractsBanner />

      {/* Hero stats */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 mb-4">
        <Stat
          className="lg:col-span-6"
          label="Total $XRGY supply"
          value={formatToken(stats.totalSupply)}
          unit={stats.tokenSymbol ?? "XRGY"}
          size="hero"
          hint="Tokens minted from verified energy. No pre-mine."
          loading={statsLoading}
        />
        <Stat
          className="lg:col-span-3"
          label="Floating index"
          value={formatFloatingIndex(floatingIndex)}
          unit="kWh / token"
          hint="Energy density of every $XRGY in circulation."
        />
        <Stat
          className="lg:col-span-3"
          label="Current era"
          value={era.era !== undefined ? Number(era.era).toString() : "—"}
          hint={
            era.rate !== undefined
              ? `Mint rate: ${formatEraRate(era.rate)} XRGY / kWh`
              : "Loading rate…"
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Stat
          className="lg:col-span-4"
          label="Verified energy in storage"
          value={formatKwh(stats.totalVerifiedEnergyInStorage)}
          unit="kWh"
          hint="Net real-time charge across the network."
          loading={statsLoading}
        />
        <Stat
          className="lg:col-span-4"
          label="Cumulative energy verified"
          value={formatKwh(cumulativeKwh)}
          unit="kWh"
          hint="Sum of every verified mint — strictly increasing."
          loading={mintsLoading}
        />
        <Stat
          className="lg:col-span-4"
          label="Current epoch"
          value={stats.currentEpoch !== undefined ? Number(stats.currentEpoch).toString() : "—"}
          hint={`${Number(stats.epochLength) / 3600}h epoch length`}
          loading={statsLoading}
        />
      </div>

      {/* Recent epoch settlements */}
      <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-12">
        <Card className="lg:col-span-7">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Recent epoch mints</CardTitle>
            <span className="flex items-center gap-2 text-xs text-fg-subtle">
              <span className="live-dot" /> Live
            </span>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Epoch</TableHead>
                  <TableHead>VPP</TableHead>
                  <TableHead className="text-right">kWh verified</TableHead>
                  <TableHead className="text-right">$XRGY minted</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mintsLoading && mints.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-fg-subtle py-8">
                      Loading mint events…
                    </TableCell>
                  </TableRow>
                )}
                {!mintsLoading && mints.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-fg-subtle py-8">
                      No mints yet. Awaiting first verified epoch.
                    </TableCell>
                  </TableRow>
                )}
                {mints.map((m) => (
                  <TableRow key={m.txHash + m.vpp}>
                    <TableCell className="font-mono">#{m.epoch.toString()}</TableCell>
                    <TableCell className="font-mono text-fg-muted">{shortAddress(m.vpp)}</TableCell>
                    <TableCell className="text-right">{formatKwh(m.kwh)}</TableCell>
                    <TableCell className="text-right text-accent">
                      +{formatToken(m.tokens)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="lg:col-span-5">
          <CardHeader>
            <CardTitle>Active VPPs</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Operator</TableHead>
                  <TableHead className="text-right">Total kWh</TableHead>
                  <TableHead className="text-right">Total $XRGY</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activeVPPs.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-fg-subtle py-8">
                      Awaiting first VPP onboarding.
                    </TableCell>
                  </TableRow>
                )}
                {activeVPPs.map((v) => (
                  <TableRow key={v.vpp}>
                    <TableCell className="font-mono">
                      <div className="flex items-center gap-2">
                        {shortAddress(v.vpp)}
                        <Badge variant="accent">verified</Badge>
                      </div>
                      <div className="text-xs text-fg-subtle font-sans mt-0.5">
                        Last epoch · #{v.lastEpoch.toString()} · {relativeTime(undefined)}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">{formatKwh(v.totalKwh)}</TableCell>
                    <TableCell className="text-right">{formatToken(v.totalTokens)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
