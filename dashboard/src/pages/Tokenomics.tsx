import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { PageHeader } from "@/components/PageHeader";
import { Stat } from "@/components/Stat";
import { ContractsBanner } from "@/components/ContractsBanner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

import { useEraRate } from "@/hooks/useEraRate";
import { useFloatingIndex } from "@/hooks/useFloatingIndex";
import { useProtocolStats } from "@/hooks/useProtocolStats";
import { HALVING_SCHEDULE } from "@/lib/contracts";
import {
  formatToken,
  formatKwh,
  formatFloatingIndex,
  formatEraRate,
} from "@/lib/utils";

/**
 * Halving schedule + supply curve. Numbers come from Technical_Blueprint §5;
 * we render them statically so the page is informative even before any
 * tokens have been minted.
 *
 * Charts:
 *  1. Halving schedule (rate vs era, log y) — shows deflation in one glance.
 *  2. Cumulative energy required to fully mint each era — the "physical work
 *     needed" curve, which doubles every era. Investors love this one.
 */
export function Tokenomics(): JSX.Element {
  const { data: era } = useEraRate();
  const { data: floatingIndex } = useFloatingIndex();
  const { data: stats } = useProtocolStats();

  const currentEra = era.era !== undefined ? Number(era.era) : 0;

  const halvingChartData = useMemo(
    () =>
      HALVING_SCHEDULE.map((row) => ({
        era: `Era ${row.era}`,
        eraNum: row.era,
        rate: row.rateTokenPerKwh,
        cumulativeSupply: row.supplyEnd,
        energyForEra: row.energyForEraKwh,
      })),
    [],
  );

  const cumulativeEnergy = useMemo(() => {
    let acc = 0;
    return HALVING_SCHEDULE.map((row) => {
      acc += row.energyForEraKwh;
      return {
        era: `Era ${row.era}`,
        eraNum: row.era,
        cumulativeEnergyKwh: acc,
        cumulativeSupply: row.supplyEnd,
      };
    });
  }, []);

  return (
    <>
      <PageHeader
        eyebrow="Tokenomics"
        title="Halving & supply curve"
        subtitle="Mint rate halves every 1,000,000 $XRGY minted — independent of adoption, dependent on physics. Even at zero new VPPs, existing batteries keep cycling and the network keeps minting."
      />

      <ContractsBanner />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 mb-6">
        <Stat
          className="lg:col-span-4"
          label="Current era"
          value={currentEra.toString()}
          hint={`Mint rate: ${formatEraRate(era.rate)} XRGY / kWh`}
          size="hero"
        />
        <Stat
          className="lg:col-span-4"
          label="Floating index"
          value={formatFloatingIndex(floatingIndex)}
          unit="kWh / token"
          hint="Energy density per circulating $XRGY."
        />
        <Stat
          className="lg:col-span-4"
          label="Cumulative supply"
          value={formatToken(stats.totalSupply)}
          unit="XRGY"
          hint={
            era.nextHalvingAtSupply !== undefined
              ? `Next halving at ${era.nextHalvingAtSupply.toLocaleString()} XRGY`
              : "—"
          }
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <Card className="lg:col-span-7">
          <CardHeader>
            <CardTitle>Mint rate by era (log scale)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={halvingChartData} margin={{ top: 8, right: 16, bottom: 0, left: -8 }}>
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="era" stroke="hsl(var(--fg-subtle))" tickLine={false} axisLine={false} />
                  <YAxis
                    scale="log"
                    domain={[0.001, 1.5]}
                    stroke="hsl(var(--fg-subtle))"
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => v.toString()}
                  />
                  <Tooltip
                    cursor={{ stroke: "hsl(var(--border))" }}
                    formatter={(v: number) => [`${v} XRGY/kWh`, "Mint rate"]}
                  />
                  <Line
                    type="monotone"
                    dataKey="rate"
                    stroke="hsl(var(--accent))"
                    strokeWidth={2}
                    dot={{ r: 3, fill: "hsl(var(--accent))", stroke: "hsl(var(--bg))", strokeWidth: 1 }}
                    activeDot={{ r: 5 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-3 max-w-2xl text-xs leading-relaxed text-fg-subtle">
              Era 0 mints 1.0 XRGY per verified kWh. Each subsequent era requires 2× the energy for
              half the tokens. By Era 8, ≈128M kWh of stored energy mints just 1M tokens.
            </p>
          </CardContent>
        </Card>

        <Card className="lg:col-span-5">
          <CardHeader>
            <CardTitle>Cumulative energy required</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={cumulativeEnergy} margin={{ top: 8, right: 16, bottom: 0, left: -8 }}>
                  <defs>
                    <linearGradient id="energyFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--accent))" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="hsl(var(--accent))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="era" stroke="hsl(var(--fg-subtle))" tickLine={false} axisLine={false} />
                  <YAxis
                    stroke="hsl(var(--fg-subtle))"
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) =>
                      v >= 1_000_000
                        ? `${(v / 1_000_000).toFixed(0)}M`
                        : v >= 1_000
                          ? `${(v / 1_000).toFixed(0)}k`
                          : v.toString()
                    }
                  />
                  <Tooltip
                    cursor={{ stroke: "hsl(var(--border))" }}
                    formatter={(v: number) => [`${v.toLocaleString()} kWh`, "Cumulative energy"]}
                  />
                  <Area
                    type="monotone"
                    dataKey="cumulativeEnergyKwh"
                    stroke="hsl(var(--accent))"
                    strokeWidth={2}
                    fill="url(#energyFill)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Schedule table */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Halving schedule</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Era</TableHead>
                <TableHead>Supply range</TableHead>
                <TableHead className="text-right">Rate (XRGY / kWh)</TableHead>
                <TableHead className="text-right">Energy for era (kWh)</TableHead>
                <TableHead className="text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {HALVING_SCHEDULE.map((row) => {
                const status =
                  row.era < currentEra ? "past" : row.era === currentEra ? "current" : "future";
                return (
                  <TableRow key={row.era}>
                    <TableCell className="font-mono">#{row.era}</TableCell>
                    <TableCell className="font-mono">
                      {row.supplyStart.toLocaleString()} — {row.supplyEnd.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {row.rateTokenPerKwh.toString()}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatKwh(row.energyForEraKwh)}
                    </TableCell>
                    <TableCell className="text-right">
                      {status === "current" ? (
                        <Badge variant="accent">live</Badge>
                      ) : status === "past" ? (
                        <Badge variant="outline">complete</Badge>
                      ) : (
                        <span className="text-fg-subtle text-xs">queued</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="mt-8 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="panel px-5 py-4">
          <div className="stat-label mb-2">Why halving always happens</div>
          <p className="text-sm text-fg-muted leading-relaxed">
            Halving triggers by token count, not adoption. Even with zero new VPPs, existing batteries
            keep cycling — slowly in a quiet market, fast in a booming one, but always forward. After
            each halving, the same energy mints half the tokens, so each token represents more stored
            kWh. The floating index ticks up.
          </p>
        </div>
        <div className="panel px-5 py-4">
          <div className="stat-label mb-2">Why no token sale</div>
          <p className="text-sm text-fg-muted leading-relaxed">
            $XRGY is never sold. Tokens are receipts for verified physical storage — no pre-mine, no
            ICO, no allocation. Investors hold equity in Key Energy, Inc. (Delaware C-Corp); the
            corporate treasury captures 40% of protocol fees in $XRGY. This is what structurally
            distinguishes Exergy from infrastructure-token plays.
          </p>
        </div>
      </div>
    </>
  );
}
