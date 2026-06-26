"use client";

/**
 * TransferForm — in-kind transfer between two investment accounts.
 *
 * POST /api/portfolio/operations/transfer with a single holdingId. The
 * model assumes the holding row is account-agnostic (one portfolio_holdings
 * row references both accounts via holding_accounts). The picker lists
 * holdings from the SOURCE account; the destination account must already
 * be paired with that holding row — we warn the user under the dest
 * picker so they create the pairing first if missing.
 *
 * No cash leg — both legs are in-kind (qty>0 / qty<0, amount=0).
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { todayISO } from "@/lib/utils/date";
import { useEditId } from "@/lib/hooks/useEditId";
import { buildTxDrillUrl } from "@/lib/transactions/drill-url";
import { usePortfolioFormData } from "@/lib/hooks/usePortfolioFormData";
import { useAccountHoldingSelection } from "@/lib/hooks/useAccountHoldingSelection";
import { useSeedAccountFromParam } from "@/lib/hooks/useSeedAccountFromParam";

export default function TransferForm() {
  const router = useRouter();
  const { editId, isEdit } = useEditId();

  const { accounts, holdings, loading, loadError, editData } =
    usePortfolioFormData({ editId, opType: "transfer" });

  const [sourceAccountId, setSourceAccountId] = useState<string>("");
  const [destAccountId, setDestAccountId] = useState<string>("");
  const [holdingId, setHoldingId] = useState<string>("");
  const [qty, setQty] = useState<string>("");
  const [date, setDate] = useState<string>(todayISO());
  const [payee, setPayee] = useState<string>("");
  const [note, setNote] = useState<string>("");

  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [blockingClosureTxIds, setBlockingClosureTxIds] = useState<number[]>(
    [],
  );

  useEffect(() => {
    if (!editData) return;
    if (editData.sourceAccountId != null) setSourceAccountId(String(editData.sourceAccountId));
    if (editData.destAccountId != null) setDestAccountId(String(editData.destAccountId));
    if (editData.holdingId != null) setHoldingId(String(editData.holdingId));
    if (editData.qty != null) setQty(String(editData.qty));
    if (editData.date) setDate(editData.date as string);
    setPayee((editData.payee as string) ?? "");
    setNote((editData.note as string) ?? "");
  }, [editData]);

  const {
    investmentAccounts,
    selectedAccount: sourceAccount,
    accountHoldings: sourceHoldings,
  } = useAccountHoldingSelection(accounts, holdings, sourceAccountId);

  const destAccountOptions = useMemo(
    () => investmentAccounts.filter((a) => String(a.id) !== sourceAccountId),
    [investmentAccounts, sourceAccountId],
  );

  // FINLYNQ-227 — pre-select the "from" investment account from `?account=<id>`.
  useSeedAccountFromParam({
    isEdit,
    field: "source",
    validIds: useMemo(
      () => investmentAccounts.map((a) => a.id),
      [investmentAccounts],
    ),
    setValue: setSourceAccountId,
  });

  const selectedHolding = useMemo(
    () =>
      holdingId
        ? sourceHoldings.find((h) => String(h.id) === holdingId) ?? null
        : null,
    [holdingId, sourceHoldings],
  );

  // value→label maps so base-ui Select triggers show names, not ids (FINLYNQ-197).
  const sourceAccountLabelById = useMemo(
    () =>
      Object.fromEntries(
        investmentAccounts.map((a) => [
          String(a.id),
          `${a.name ?? `#${a.id}`} (${a.currency})`,
        ]),
      ),
    [investmentAccounts],
  );
  const destAccountLabelById = useMemo(
    () =>
      Object.fromEntries(
        destAccountOptions.map((a) => [
          String(a.id),
          `${a.name ?? `#${a.id}`} (${a.currency})`,
        ]),
      ),
    [destAccountOptions],
  );
  const holdingLabelById = useMemo(
    () =>
      Object.fromEntries(
        sourceHoldings.map((h) => [
          String(h.id),
          `${h.symbol ? `${h.symbol} — ` : ""}${h.name ?? `#${h.id}`} (${h.currency})`,
        ]),
      ),
    [sourceHoldings],
  );

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!sourceAccountId) e.sourceAccountId = "Pick a source account";
    if (!destAccountId) e.destAccountId = "Pick a destination account";
    if (sourceAccountId && destAccountId && sourceAccountId === destAccountId) {
      e.destAccountId = "Source and destination must differ";
    }
    if (!holdingId) e.holdingId = "Pick a holding";
    const qtyNum = parseFloat(qty);
    if (!qty || Number.isNaN(qtyNum) || qtyNum <= 0)
      e.qty = "Quantity must be > 0";
    if (!date) e.date = "Pick a date";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    setBlockingClosureTxIds([]);
    if (!validate()) return;
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        sourceAccountId: Number(sourceAccountId),
        destAccountId: Number(destAccountId),
        holdingId: Number(holdingId),
        qty: parseFloat(qty),
        date,
      };
      if (payee.trim()) body.payee = payee.trim();
      if (note.trim()) body.note = note.trim();
      if (isEdit) body.editId = editId;
      const res = await fetch("/api/portfolio/operations/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data: {
          error?: string;
          code?: string;
          blockingClosureTxIds?: unknown;
        } = await res.json().catch(() => ({}));
        if (data.code === "portfolio_edit_blocked") {
          setBlockingClosureTxIds(
            Array.isArray(data.blockingClosureTxIds)
              ? (data.blockingClosureTxIds.filter(
                  (n) => typeof n === "number",
                ) as number[])
              : [],
          );
          setSubmitError(
            data.error ?? "Edit blocked — dependent transactions exist",
          );
        } else {
          setSubmitError(data.error ?? `Save failed (${res.status})`);
        }
        return;
      }
      router.push("/transactions");
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground">
          Loading…
        </CardContent>
      </Card>
    );
  }
  if (loadError) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-destructive">
          {loadError}
        </CardContent>
      </Card>
    );
  }
  if (investmentAccounts.length < 2) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Need two investment accounts</CardTitle>
          <CardDescription>
            In-kind transfers require two investment accounts. You currently have{" "}
            {investmentAccounts.length}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/accounts" className="text-sm text-primary underline">
            Go to Accounts →
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {isEdit ? "Edit In-kind transfer" : "In-kind transfer"}
        </CardTitle>
        <CardDescription>
          Move shares of a single holding between two investment accounts. No
          cash leg — qty leaves the source and arrives in the destination at the
          same lot cost basis.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Source account</Label>
              <Select
                items={sourceAccountLabelById}
                value={sourceAccountId}
                onValueChange={(v) => {
                  setSourceAccountId(v ?? "");
                  setHoldingId("");
                  if (v === destAccountId) setDestAccountId("");
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Pick source" />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false} side="bottom">
                  {investmentAccounts.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.name ?? `#${a.id}`} ({a.currency})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.sourceAccountId && (
                <p className="text-xs text-destructive">
                  {errors.sourceAccountId}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Destination account</Label>
              <Select
                items={destAccountLabelById}
                value={destAccountId}
                onValueChange={(v) => setDestAccountId(v ?? "")}
                disabled={!sourceAccountId}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Pick destination" />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false} side="bottom">
                  {destAccountOptions.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.name ?? `#${a.id}`} ({a.currency})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.destAccountId && (
                <p className="text-xs text-destructive">
                  {errors.destAccountId}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Make sure the destination account is already paired with the
                holding you pick below.
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Holding (from source account)</Label>
            <Select
              items={holdingLabelById}
              value={holdingId}
              onValueChange={(v) => setHoldingId(v ?? "")}
              disabled={!sourceAccount}
            >
              <SelectTrigger className="w-full">
                <SelectValue
                  placeholder={
                    sourceAccount
                      ? sourceHoldings.length === 0
                        ? "No non-cash holdings in source"
                        : "Pick a holding"
                      : "Pick source account first"
                  }
                />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false} side="bottom">
                {sourceHoldings.map((h) => (
                  <SelectItem key={h.id} value={String(h.id)}>
                    {h.symbol ? `${h.symbol} — ` : ""}
                    {h.name ?? `#${h.id}`} ({h.currency})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.holdingId && (
              <p className="text-xs text-destructive">{errors.holdingId}</p>
            )}
            {selectedHolding && (
              <p className="text-xs text-muted-foreground">
                Source has {Number(selectedHolding.currentShares ?? 0).toLocaleString()} shares available.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Quantity</Label>
              <Input
                type="number"
                step="any"
                inputMode="decimal"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                placeholder="50"
              />
              {errors.qty && (
                <p className="text-xs text-destructive">{errors.qty}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Date</Label>
              <Input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
              {errors.date && (
                <p className="text-xs text-destructive">{errors.date}</p>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>
              Payee{" "}
              <span className="text-muted-foreground text-xs">(optional)</span>
            </Label>
            <Input
              value={payee}
              onChange={(e) => setPayee(e.target.value)}
              placeholder="e.g. ACATS transfer"
            />
          </div>

          <div className="space-y-1.5">
            <Label>
              Note{" "}
              <span className="text-muted-foreground text-xs">(optional)</span>
            </Label>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder=""
            />
          </div>

          {submitError && (
            <p className="text-sm text-destructive">{submitError}</p>
          )}

          {blockingClosureTxIds.length > 0 && (
            <div className="rounded-md border border-amber-300/60 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-800/60 p-3 text-xs">
              <p className="font-medium text-amber-900 dark:text-amber-200 mb-1.5">
                Delete these dependent transactions first:
              </p>
              <ul className="space-y-1">
                {blockingClosureTxIds.map((id) => (
                  <li key={id}>
                    <Link
                      href={buildTxDrillUrl({ id: String(id) })}
                      className="text-amber-700 dark:text-amber-300 underline hover:no-underline"
                    >
                      Transaction #{id}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={() => router.push("/portfolio/new")}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="flex-1"
              disabled={submitting || !!loadError}
            >
              {submitting
                ? isEdit
                  ? "Saving…"
                  : "Recording…"
                : isEdit
                  ? "Save edit"
                  : "Record transfer"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
