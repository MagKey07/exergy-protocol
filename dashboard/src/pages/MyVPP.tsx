import { useAccount } from "wagmi";
import { useReadContract } from "wagmi";

import { PageHeader } from "@/components/PageHeader";
import { Stat } from "@/components/Stat";
import { ContractsBanner } from "@/components/ContractsBanner";
import { EmptyState } from "@/components/EmptyState";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ConnectButton } from "@rainbow-me/rainbowkit";

import { xrgyTokenAbi } from "@/lib/contracts";
import { contractAddresses } from "@/wagmi";
import { useVPPDevices } from "@/hooks/useVPPDevices";
import { useMintEvents } from "@/hooks/useMintEvents";
import { formatToken, formatKwh, shortAddress, relativeTime } from "@/lib/utils";

/**
 * Operator's view of THEIR VPP. Wallet-gated — without a connection there's
 * no operator to render.
 *
 * Layout:
 *  - Hero $XRGY balance (treasury for this operator)
 *  - Devices count, total kWh verified across operator's fleet
 *  - Devices preview table
 *  - Recent mints credited to this VPP address
 */
export function MyVPP(): JSX.Element {
  const { address, isConnected } = useAccount();

  const { data: balance, isLoading: balLoading } = useReadContract({
    address: contractAddresses.xrgyToken,
    abi: xrgyTokenAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: {
      enabled: Boolean(address),
      staleTime: 15_000,
      refetchInterval: 30_000,
    },
  });

  const { data: devices, isLoading: devicesLoading } = useVPPDevices(address);
  const { data: mints, isLoading: mintsLoading } = useMintEvents({
    vpp: address,
    limit: 10,
  });

  const totalKwhFromMints = mints.reduce((sum, m) => sum + m.kwh, 0n);
  const lastReportedDevice = devices.find((d) => d.lastReportedAt);
  const lastReportedAt = lastReportedDevice?.lastReportedAt;

  if (!isConnected) {
    return (
      <>
        <PageHeader
          eyebrow="Operator"
          title="My VPP"
          subtitle="Connect a wallet to see this VPP's verified storage, device fleet, and mint history."
        />
        <EmptyState
          title="Connect your operator wallet"
          description="Each VPP is identified by the cloud-signer address that registered its devices. Connect that address to view the operator dashboard."
          action={<ConnectButton showBalance={false} chainStatus="none" />}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Operator"
        title="My VPP"
        subtitle={
          <>
            Operator address:{" "}
            <span className="font-mono text-fg">{shortAddress(address)}</span>
          </>
        }
        actions={
          <Badge variant="accent" className="hidden sm:inline-flex">
            <span className="live-dot mr-2" /> Active session
          </Badge>
        }
      />

      <ContractsBanner />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 mb-4">
        <Stat
          className="lg:col-span-6"
          label="$XRGY balance"
          value={formatToken(balance as bigint | undefined)}
          unit="XRGY"
          size="hero"
          hint="Treasury for this VPP. Settles grid bills + cross-VPP imports."
          loading={balLoading}
        />
        <Stat
          className="lg:col-span-3"
          label="Registered devices"
          value={devices.length.toString()}
          hint={lastReportedAt ? `Last report ${relativeTime(lastReportedAt)}` : "—"}
          loading={devicesLoading}
        />
        <Stat
          className="lg:col-span-3"
          label="kWh verified (recent)"
          value={formatKwh(totalKwhFromMints)}
          unit="kWh"
          hint="Sum of last 10 epoch mints."
          loading={mintsLoading}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <Card className="lg:col-span-7">
          <CardHeader>
            <CardTitle>Device fleet</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Device ID</TableHead>
                  <TableHead className="text-right">Last kWh</TableHead>
                  <TableHead className="text-right">Last seen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {devicesLoading && devices.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-fg-subtle py-8">
                      Reading device registry…
                    </TableCell>
                  </TableRow>
                )}
                {!devicesLoading && devices.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-fg-subtle py-8">
                      No devices registered for this address.
                    </TableCell>
                  </TableRow>
                )}
                {devices.map((d) => (
                  <TableRow key={d.deviceId}>
                    <TableCell className="font-mono">{shortAddress(d.deviceId, 10, 6)}</TableCell>
                    <TableCell className="text-right">
                      {d.lastReportedKwh !== undefined ? formatKwh(d.lastReportedKwh) : "—"}
                    </TableCell>
                    <TableCell className="text-right text-fg-muted">
                      {d.lastReportedAt ? relativeTime(d.lastReportedAt) : "never"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="lg:col-span-5">
          <CardHeader>
            <CardTitle>Recent epoch mints</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Epoch</TableHead>
                  <TableHead className="text-right">kWh</TableHead>
                  <TableHead className="text-right">Minted</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mintsLoading && mints.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-fg-subtle py-8">
                      Loading…
                    </TableCell>
                  </TableRow>
                )}
                {!mintsLoading && mints.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-fg-subtle py-8">
                      No mints yet for this VPP.
                    </TableCell>
                  </TableRow>
                )}
                {mints.map((m) => (
                  <TableRow key={m.txHash}>
                    <TableCell className="font-mono">#{m.epoch.toString()}</TableCell>
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
      </div>
    </>
  );
}
