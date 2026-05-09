import { useEffect, useMemo, useState } from "react";
import { usePublicClient } from "wagmi";
import type { Address, Log } from "viem";
import { parseAbiItem } from "viem";

import { contractAddresses, contractsConfigured } from "@/wagmi";

/**
 * Reconstruct a VPP's device fleet from on-chain events.
 *
 * The OracleRouter emits `DeviceRegistered(deviceId, vppAddress, devicePubKeyHash)`.
 * For a given VPP we filter events where `vppAddress == vpp` and resolve the
 * latest `MeasurementVerified` per deviceId for "last reported kWh".
 *
 * Phase 0 implementation: brute-force getLogs from the deploy block. Once the
 * indexer subgraph is up (Phase 1), this hook should be swapped for a
 * subgraph query — the public surface stays identical.
 */
export interface DeviceRow {
  deviceId: `0x${string}`;
  vppAddress: Address;
  registeredAtBlock: bigint;
  lastReportedKwh?: bigint;
  lastReportedAt?: bigint; // unix seconds
  cumulativeCycles?: number; // not on-chain in events; surfaced via packet inspection in Phase 1
  active?: boolean;
}

const DEVICE_REGISTERED = parseAbiItem(
  "event DeviceRegistered(bytes32 indexed deviceId, address indexed vppAddress, bytes32 devicePubKeyHash)",
);
const MEASUREMENT_VERIFIED = parseAbiItem(
  "event MeasurementVerified(bytes32 indexed deviceId, address indexed vppAddress, uint256 kwhAmount, uint64 timestamp, uint256 epoch)",
);

interface UseVPPDevicesResult {
  data: DeviceRow[];
  isLoading: boolean;
  error: Error | null;
}

export function useVPPDevices(vpp: Address | undefined): UseVPPDevicesResult {
  const client = usePublicClient();
  const [data, setData] = useState<DeviceRow[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);

  const enabled = useMemo(
    () => Boolean(vpp && client && contractsConfigured()),
    [vpp, client],
  );

  useEffect(() => {
    if (!enabled || !client || !vpp) {
      setData([]);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    (async () => {
      try {
        // 1. Pull all DeviceRegistered events for this VPP.
        const registerLogs = await client.getLogs({
          address: contractAddresses.oracleRouter,
          event: DEVICE_REGISTERED,
          args: { vppAddress: vpp },
          fromBlock: BigInt(import.meta.env.VITE_DEPLOY_BLOCK ?? "0"),
          toBlock: "latest",
        });

        const devices = new Map<string, DeviceRow>();
        for (const log of registerLogs as Array<Log & { args: { deviceId: `0x${string}`; vppAddress: Address } }>) {
          const id = log.args.deviceId;
          if (!devices.has(id)) {
            devices.set(id, {
              deviceId: id,
              vppAddress: log.args.vppAddress,
              registeredAtBlock: log.blockNumber ?? 0n,
            });
          }
        }

        // 2. For each device, resolve the latest measurement log to populate
        //    "last reported kWh" + cycle count. We could getLogs once for the
        //    whole VPP, but per-device keeps memory bounded for large fleets.
        const measurementLogs = await client.getLogs({
          address: contractAddresses.oracleRouter,
          event: MEASUREMENT_VERIFIED,
          args: { vppAddress: vpp },
          fromBlock: BigInt(import.meta.env.VITE_DEPLOY_BLOCK ?? "0"),
          toBlock: "latest",
        });

        for (const log of measurementLogs as Array<
          Log & { args: { deviceId: `0x${string}`; kwhAmount: bigint; timestamp: bigint } }
        >) {
          const id = log.args.deviceId;
          const row = devices.get(id);
          if (!row) continue;
          const ts = BigInt(log.args.timestamp);
          if (!row.lastReportedAt || ts > row.lastReportedAt) {
            row.lastReportedAt = ts;
            row.lastReportedKwh = log.args.kwhAmount;
          }
        }

        if (!cancelled) setData(Array.from(devices.values()));
      } catch (e) {
        if (!cancelled) setError(e as Error);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, client, vpp]);

  return { data, isLoading, error };
}
