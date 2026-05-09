import { useEffect, useMemo, useState } from "react";
import { usePublicClient } from "wagmi";
import type { Address, Log } from "viem";
import { parseAbiItem } from "viem";

import { PageHeader } from "@/components/PageHeader";
import { ContractsBanner } from "@/components/ContractsBanner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

import { contractAddresses, contractsConfigured } from "@/wagmi";
import { formatKwh, shortAddress, relativeTime } from "@/lib/utils";

/**
 * Network-wide device registry.
 *
 * Reads ALL DeviceRegistered events + the latest MeasurementVerified per
 * device to surface "what is the network actually doing right now".
 *
 * Proof-of-Wear is visible per-device via cumulative-cycles. The events don't
 * carry that field directly (the value is in the inner MeasurementPacket
 * struct passed to OracleRouter.submitMeasurement, which the contract emits
 * separately). For Phase 0 we display "—" and add a note; Phase 1 wires this
 * via the indexer once the contracts agent settles the event surface.
 */

const DEVICE_REGISTERED = parseAbiItem(
  "event DeviceRegistered(bytes32 indexed deviceId, address indexed vppAddress, bytes32 devicePubKeyHash)",
);
const MEASUREMENT_VERIFIED = parseAbiItem(
  "event MeasurementVerified(bytes32 indexed deviceId, address indexed vppAddress, uint256 kwhAmount, uint64 timestamp, uint256 epoch)",
);

interface NetworkDevice {
  deviceId: `0x${string}`;
  vpp: Address;
  registeredAtBlock: bigint;
  lastReportedKwh?: bigint;
  lastReportedAt?: bigint;
  measurementCount: number;
}

export function Devices(): JSX.Element {
  const client = usePublicClient();
  const [devices, setDevices] = useState<NetworkDevice[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [filter, setFilter] = useState<string>("");

  useEffect(() => {
    if (!client || !contractsConfigured()) return;
    let cancelled = false;
    setIsLoading(true);

    (async () => {
      try {
        const [regLogs, measLogs] = await Promise.all([
          client.getLogs({
            address: contractAddresses.oracleRouter,
            event: DEVICE_REGISTERED,
            fromBlock: BigInt(import.meta.env.VITE_DEPLOY_BLOCK ?? "0"),
            toBlock: "latest",
          }),
          client.getLogs({
            address: contractAddresses.oracleRouter,
            event: MEASUREMENT_VERIFIED,
            fromBlock: BigInt(import.meta.env.VITE_DEPLOY_BLOCK ?? "0"),
            toBlock: "latest",
          }),
        ]);

        const map = new Map<string, NetworkDevice>();
        for (const log of regLogs as Array<
          Log & { args: { deviceId: `0x${string}`; vppAddress: Address } }
        >) {
          map.set(log.args.deviceId, {
            deviceId: log.args.deviceId,
            vpp: log.args.vppAddress,
            registeredAtBlock: log.blockNumber ?? 0n,
            measurementCount: 0,
          });
        }
        for (const log of measLogs as Array<
          Log & {
            args: { deviceId: `0x${string}`; kwhAmount: bigint; timestamp: bigint };
          }
        >) {
          const d = map.get(log.args.deviceId);
          if (!d) continue;
          d.measurementCount += 1;
          const ts = BigInt(log.args.timestamp);
          if (!d.lastReportedAt || ts > d.lastReportedAt) {
            d.lastReportedAt = ts;
            d.lastReportedKwh = log.args.kwhAmount;
          }
        }
        if (!cancelled) setDevices(Array.from(map.values()));
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[Devices] getLogs failed:", e);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client]);

  const filtered = useMemo(() => {
    if (!filter.trim()) return devices;
    const f = filter.trim().toLowerCase();
    return devices.filter(
      (d) => d.deviceId.toLowerCase().includes(f) || d.vpp.toLowerCase().includes(f),
    );
  }, [devices, filter]);

  return (
    <>
      <PageHeader
        eyebrow="Registry"
        title="Devices"
        subtitle="Every battery system whose readings can mint $XRGY. Each entry is bound to a VPP cloud-signer and a device-side ECDSA key — measurements without both signatures are rejected at the contract level."
      />

      <ContractsBanner />

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>{devices.length} registered devices</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            <Input
              type="search"
              placeholder="Filter by deviceId or VPP…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="w-72"
            />
          </div>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Device ID</TableHead>
                <TableHead>VPP</TableHead>
                <TableHead className="text-right">Last kWh</TableHead>
                <TableHead className="text-right">Cycles</TableHead>
                <TableHead className="text-right">Measurements</TableHead>
                <TableHead className="text-right">Last seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && devices.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-fg-subtle py-8">
                    Reading device registry from chain…
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-fg-subtle py-8">
                    {devices.length === 0
                      ? "No devices registered yet."
                      : "No devices match this filter."}
                  </TableCell>
                </TableRow>
              )}
              {filtered.map((d) => (
                <TableRow key={d.deviceId}>
                  <TableCell className="font-mono">{shortAddress(d.deviceId, 10, 6)}</TableCell>
                  <TableCell className="font-mono text-fg-muted">{shortAddress(d.vpp)}</TableCell>
                  <TableCell className="text-right">
                    {d.lastReportedKwh !== undefined ? formatKwh(d.lastReportedKwh) : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="text-fg-subtle" title="Proof-of-Wear (Phase 1 indexer)">—</span>
                  </TableCell>
                  <TableCell className="text-right">{d.measurementCount}</TableCell>
                  <TableCell className="text-right text-fg-muted">
                    {d.lastReportedAt ? relativeTime(d.lastReportedAt) : (
                      <Badge variant="warn">no data</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <p className="mt-6 max-w-3xl text-xs leading-relaxed text-fg-subtle">
        <span className="text-fg-muted">Proof-of-Wear:</span> every charge cycle physically degrades
        the battery (~$0.10 / kWh cycled, industry-average lithium-ion). The cumulative-cycles field
        in each measurement packet is tracked on-chain and surfaced here once the indexer is wired —
        this is the native Sybil resistance: wash-trading pays real hardware cost.
      </p>
    </>
  );
}
