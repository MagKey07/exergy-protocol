import { useMemo, useState } from "react";
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { isAddress, parseUnits, keccak256, toHex, type Address, type Hex } from "viem";

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
 *  1. P2P (intra-VPP): operator pays a participant within their own VPP via
 *     `settleEnergy(provider, tokenAmount, kwhConsumed)`. We pass kwhConsumed
 *     = 0 from this UI — pure token settlement without consumption-recording.
 *     Operators that want to record consumption use the metering pipeline.
 *  2. Cross-VPP: operator pays a participant of another VPP via
 *     `crossVPPSettle(receiver, counterpartyVPPId, tokenAmount)`. The
 *     counterparty VPP identifier (bytes32) is derived from the counterparty
 *     VPP address entered in the form.
 *
 * Both flows apply the protocol settlement fee (`settlementFeeBps`,
 * default 25 = 0.25%, distributed Treasury 40% / Team 20% / Ecosystem 25% /
 * Insurance 15% per Technical_Blueprint §2.4). The fee is paid ON TOP of the
 * principal: the recipient receives the full `tokenAmount` and the payer pays
 * `tokenAmount + fee`. Approve `tokenAmount + fee` to Settlement before submit.
 *
 * Memo is an off-chain note; the contract has no memo parameter, so it is
 * never sent to chain. We still hash it locally for operator bookkeeping.
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
        subtitle="Pay participants in the energy they helped store. Protocol fee 0.25% (paid on top of the principal) — Treasury 40% / Team 20% / Ecosystem 25% / Insurance 15%."
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

  // Fee is on top of the principal — payer pays principal + fee, recipient gets full principal.
  const totalDebit = amountWei !== undefined && feePreview !== undefined
    ? amountWei + feePreview
    : undefined;

  const insufficient = balance !== undefined && totalDebit !== undefined && balance < totalDebit;

  // Hashed locally for operator bookkeeping. NOT sent on-chain — Settlement.sol has no memo parameter.
  const memoHash = useMemo<Hex>(() => {
    if (!memo.trim()) return ("0x" + "0".repeat(64)) as Hex;
    return keccak256(toHex(memo));
  }, [memo]);

  // Cross-VPP requires a bytes32 counterparty VPP identifier. Derive it deterministically
  // from the counterparty VPP address entered in the form (keccak256 of the lower-cased addr).
  // Off-chain registry can map this digest back to a human-readable VPP name.
  const counterpartyVPPId = useMemo<Hex>(() => {
    if (kind !== "cross" || !toVpp || !isAddress(toVpp)) {
      return ("0x" + "0".repeat(64)) as Hex;
    }
    return keccak256(toHex(toVpp.toLowerCase()));
  }, [kind, toVpp]);

  const { writeContract, data: txHash, isPending, error } = useWriteContract();
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  const canSubmit =
    validRecipient && validVpp && amountWei !== undefined && !insufficient && !isPending;

  const onSubmit = (): void => {
    if (!canSubmit || !amountWei) return;
    if (kind === "p2p") {
      // settleEnergy(provider, tokenAmount, kwhConsumed). UI does pure token
      // settlement — kwhConsumed = 0; consumption-recording is the metering
      // pipeline's job, not this manual operator form.
      writeContract({
        address: contractAddresses.settlement,
        abi: settlementAbi,
        functionName: "settleEnergy",
        args: [to as Address, amountWei, 0n],
      });
    } else {
      // crossVPPSettle(receiver, counterpartyVPPId, tokenAmount). Three args —
      // no memoHash on-chain. The memo input is operator bookkeeping only.
      writeContract({
        address: contractAddresses.settlement,
        abi: settlementAbi,
        functionName: "crossVPPSettle",
        args: [to as Address, counterpartyVPPId, amountWei],
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

        <Field label="Memo (optional)" hint="Off-chain bookkeeping only — Settlement.sol has no memo parameter. Hashed locally for your records.">
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

        <PreviewRow
          label="Recipient receives"
          value={amountWei !== undefined ? `${formatToken(amountWei)} XRGY` : "—"}
          emphasis
        />
        <PreviewRow
          label={`Fee (${formatBps(feeBps)}, on top)`}
          value={feePreview !== undefined ? `${formatToken(feePreview)} XRGY` : "—"}
        />
        <div className="hairline" />
        <PreviewRow
          label="Total debited from you"
          value={totalDebit !== undefined ? `${formatToken(totalDebit)} XRGY` : "—"}
          emphasis
        />
        <PreviewRow
          label="Memo hash (off-chain)"
          value={<span className="font-mono text-xs">{shortAddress(memoHash, 10, 8)}</span>}
        />
        {kind === "cross" && (
          <PreviewRow
            label="Counterparty VPP id"
            value={
              <span className="font-mono text-xs">{shortAddress(counterpartyVPPId, 10, 8)}</span>
            }
          />
        )}

        {insufficient && (
          <div className="text-xs text-danger">
            Insufficient $XRGY balance — fee is paid on top of the principal.
          </div>
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
