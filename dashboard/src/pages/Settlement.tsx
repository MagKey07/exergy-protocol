import { useMemo, useState } from "react";
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { isAddress, parseUnits, keccak256, toHex, type Address } from "viem";

import { PageHeader } from "@/components/PageHeader";
import { ContractsBanner } from "@/components/ContractsBanner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { ConnectButton } from "@rainbow-me/rainbowkit";

import { settlementAbi, xrgyTokenAbi } from "@/lib/contracts";
import { contractAddresses } from "@/wagmi";
import { formatBps, formatToken, shortAddress } from "@/lib/utils";

/**
 * P2P + cross-VPP settlement form.
 *
 * Two tabs:
 *  1. P2P (intra-VPP): operator pays a participant within their own VPP.
 *  2. Cross-VPP: operator A buys energy from VPP B, pays to participant of B.
 *
 * Both flows hit Settlement.sol and apply the protocol fee (`settlementFeeBps`,
 * default 25 = 0.25%, distributed Treasury 40% / Team 20% / Ecosystem 25% / Insurance 15%
 * per Technical_Blueprint §2.4).
 *
 * Memo is hashed client-side — operators reference an off-chain energy
 * settlement record (e.g. a metering invoice) without putting personal data
 * on-chain.
 */
export function Settlement(): JSX.Element {
  const { address, isConnected } = useAccount();

  const { data: feeBps } = useReadContract({
    address: contractAddresses.settlement,
    abi: settlementAbi,
    functionName: "settlementFeeBps",
    query: { staleTime: 5 * 60_000 },
  });

  const { data: balance } = useReadContract({
    address: contractAddresses.xrgyToken,
    abi: xrgyTokenAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address), staleTime: 15_000, refetchInterval: 30_000 },
  });

  if (!isConnected) {
    return (
      <>
        <PageHeader
          eyebrow="Settlement"
          title="Settle in $XRGY"
          subtitle="Operators pay participants for delivered energy in the same unit they minted from. P2P stays within one VPP; cross-VPP routes through Settlement.sol with a 0.25% protocol fee."
        />
        <EmptyState
          title="Connect a wallet to settle"
          description="Settlement transfers are signed by the VPP operator. Connect your operator wallet to issue P2P or cross-VPP payments."
          action={<ConnectButton showBalance={false} chainStatus="none" />}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Settlement"
        title="Settle in $XRGY"
        subtitle="Pay participants in the energy they helped store. Protocol fee 0.25% — Treasury 40% / Team 20% / Ecosystem 25% / Insurance 15%."
      />

      <ContractsBanner />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 mb-6">
        <div className="panel px-5 py-4 lg:col-span-4">
          <div className="stat-label">Available balance</div>
          <div className="stat-value mt-2">{formatToken(balance as bigint | undefined)}</div>
          <div className="text-xs text-fg-subtle mt-1">XRGY · {shortAddress(address)}</div>
        </div>
        <div className="panel px-5 py-4 lg:col-span-4">
          <div className="stat-label">Settlement fee</div>
          <div className="stat-value mt-2">{formatBps(feeBps as bigint | undefined)}</div>
          <div className="text-xs text-fg-subtle mt-1">applied at the contract</div>
        </div>
        <div className="panel px-5 py-4 lg:col-span-4">
          <div className="stat-label">Network</div>
          <div className="stat-value mt-2 text-xl">Arbitrum Sepolia</div>
          <div className="text-xs text-fg-subtle mt-1">Phase 0 testnet</div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>New transfer</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="p2p">
            <TabsList>
              <TabsTrigger value="p2p">P2P · same VPP</TabsTrigger>
              <TabsTrigger value="cross">Cross-VPP</TabsTrigger>
            </TabsList>
            <TabsContent value="p2p">
              <SettlementForm kind="p2p" feeBps={feeBps as bigint | undefined} balance={balance as bigint | undefined} />
            </TabsContent>
            <TabsContent value="cross">
              <SettlementForm kind="cross" feeBps={feeBps as bigint | undefined} balance={balance as bigint | undefined} />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <p className="mt-6 max-w-3xl text-xs leading-relaxed text-fg-subtle">
        <span className="text-fg-muted">Why no burn:</span> when energy is consumed, $XRGY transfers
        to the energy provider — it keeps circulating like money. The floating index self-regulates
        as <code className="font-mono">totalVerifiedEnergyInStorage</code> moves with physical
        reality. Coupons get burned; money does not.
      </p>
    </>
  );
}

interface SettlementFormProps {
  kind: "p2p" | "cross";
  feeBps: bigint | undefined;
  balance: bigint | undefined;
}

function SettlementForm({ kind, feeBps, balance }: SettlementFormProps): JSX.Element {
  const [toVpp, setToVpp] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [amount, setAmount] = useState<string>("");
  const [memo, setMemo] = useState<string>("");

  const validRecipient = useMemo(() => to && isAddress(to), [to]);
  const validVpp = useMemo(() => kind === "p2p" || (toVpp && isAddress(toVpp)), [kind, toVpp]);

  const amountWei = useMemo(() => {
    try {
      if (!amount || Number(amount) <= 0) return undefined;
      return parseUnits(amount, 18);
    } catch {
      return undefined;
    }
  }, [amount]);

  const feePreview = useMemo(() => {
    if (amountWei === undefined || feeBps === undefined) return undefined;
    return (amountWei * feeBps) / 10_000n;
  }, [amountWei, feeBps]);

  const netToRecipient = amountWei !== undefined && feePreview !== undefined
    ? amountWei - feePreview
    : undefined;

  const insufficient = balance !== undefined && amountWei !== undefined && balance < amountWei;

  const memoHash = useMemo<`0x${string}`>(() => {
    if (!memo.trim()) return ("0x" + "0".repeat(64)) as `0x${string}`;
    return keccak256(toHex(memo));
  }, [memo]);

  const { writeContract, data: txHash, isPending, error } = useWriteContract();
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  const canSubmit =
    validRecipient && validVpp && amountWei !== undefined && !insufficient && !isPending;

  const onSubmit = (): void => {
    if (!canSubmit || !amountWei) return;
    if (kind === "p2p") {
      writeContract({
        address: contractAddresses.settlement,
        abi: settlementAbi,
        functionName: "settle",
        args: [to as Address, amountWei, memoHash],
      });
    } else {
      writeContract({
        address: contractAddresses.settlement,
        abi: settlementAbi,
        functionName: "settleCrossVPP",
        args: [toVpp as Address, to as Address, amountWei, memoHash],
      });
    }
  };

  return (
    <div className="grid grid-cols-1 gap-4 mt-2 lg:grid-cols-2">
      <div className="space-y-3">
        {kind === "cross" && (
          <Field label="Counterparty VPP" hint="Cloud-signer address of the destination VPP.">
            <Input
              placeholder="0x…"
              value={toVpp}
              onChange={(e) => setToVpp(e.target.value)}
              spellCheck={false}
            />
          </Field>
        )}

        <Field
          label="Recipient address"
          hint={kind === "p2p" ? "Participant in your VPP." : "Participant in the destination VPP."}
        >
          <Input
            placeholder="0x…"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            spellCheck={false}
          />
        </Field>

        <Field label="Amount" hint="Whole or fractional $XRGY.">
          <div className="relative">
            <Input
              type="number"
              inputMode="decimal"
              step="any"
              placeholder="0.0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-fg-subtle">
              XRGY
            </span>
          </div>
        </Field>

        <Field label="Memo (optional)" hint="Hashed on-chain. Off-chain reference, e.g. invoice ID.">
          <Input
            placeholder="grid-bill-2026-05-08-meter-3142"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            className="font-sans"
          />
        </Field>
      </div>

      <div className="panel px-5 py-4 flex flex-col gap-3 self-start">
        <div className="flex items-center justify-between">
          <span className="stat-label">Preview</span>
          <Badge variant={kind === "p2p" ? "default" : "accent"}>
            {kind === "p2p" ? "Intra-VPP" : "Cross-VPP"}
          </Badge>
        </div>

        <PreviewRow label="Send" value={amountWei !== undefined ? `${formatToken(amountWei)} XRGY` : "—"} />
        <PreviewRow
          label={`Fee (${formatBps(feeBps)})`}
          value={feePreview !== undefined ? `${formatToken(feePreview)} XRGY` : "—"}
        />
        <div className="hairline" />
        <PreviewRow
          label="Recipient receives"
          value={netToRecipient !== undefined ? `${formatToken(netToRecipient)} XRGY` : "—"}
          emphasis
        />
        <PreviewRow
          label="Memo hash"
          value={<span className="font-mono text-xs">{shortAddress(memoHash, 10, 8)}</span>}
        />

        {insufficient && (
          <div className="text-xs text-danger">Insufficient $XRGY balance.</div>
        )}
        {error && <div className="text-xs text-danger break-words">{(error as Error).message}</div>}
        {isSuccess && (
          <div className="text-xs text-accent">
            Settled. Tx <span className="font-mono">{shortAddress(txHash)}</span>
          </div>
        )}

        <Button
          onClick={onSubmit}
          disabled={!canSubmit || confirming}
          className="mt-2"
        >
          {isPending ? "Confirm in wallet…" : confirming ? "Settling…" : "Submit settlement"}
        </Button>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label className="block">
      <div className="stat-label mb-1.5">{label}</div>
      {children}
      {hint && <div className="mt-1 text-xs text-fg-subtle">{hint}</div>}
    </label>
  );
}

function PreviewRow({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: React.ReactNode;
  emphasis?: boolean;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-fg-muted">{label}</span>
      <span className={emphasis ? "font-mono text-fg" : "font-mono text-fg-muted"}>{value}</span>
    </div>
  );
}
