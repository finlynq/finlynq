"use client";

/**
 * BuyForm — Phase 2 of plan/portfolio-lots-and-performance.md.
 *
 * Records a Buy operation via POST /api/portfolio/operations/buy:
 *   pick investment account → pick non-cash holding → enter qty + totalCost
 *
 * Cash leg is inferred server-side from the (account, holding.currency) sleeve.
 * If the sleeve doesn't exist the server returns code:"cash_sleeve_not_found"
 * which we surface inline with a pointer to the account page.
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
import { formatCurrency } from "@/lib/currency";
import { todayISO } from "@/lib/utils/date";
import { useEditId } from "@/lib/hooks/useEditId";
import { buildTxDrillUrl } from "@/lib/transactions/drill-url";
import { usePortfolioFormData } from "@/lib/hooks/usePortfolioFormData";
import { useAccountHoldingSelection } from "@/lib/hooks/useAccountHoldingSelection";
import { useSeedAccountFromParam } from "@/lib/hooks/useSeedAccountFromParam";

export default function BuyForm() {
  const router = useRouter();
  const { editId, isEdit } = useEditId();

  const { accounts, holdings, loading, loadError, editData } =
    usePortfolioFormData({ editId, opType: "buy" });

  const [accountId, setAccountId] = useState<string>("");
  const [holdingId, setHoldingId] = useState<string>("");
  const [qty, setQty] = useState<string>("");
  const [totalCost, setTotalCost] = useState<string>("");
  const [date, setDate] = useState<string>(todayISO());
  const [payee, setPayee] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const [tags, setTags] = useState<string>("");

  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [blockingClosureTxIds, setBlockingClosureTxIds] = useState<number[]>(
    [],
  );

  useEffect(() => {
    if (!editData) return;
    if (editData.accountId != null) setAccountId(String(editData.accountId));
    if (editData.holdingId != null) setHoldingId(String(editData.holdingId));
    if (editData.qty != null) setQty(String(editData.qty));
    if (editData.totalCost != null) setTotalCost(String(editData.totalCost));
    if (editData.date) setDate(editData.date as string);
    setPayee((editData.payee as string) ?? "");
    setNote((editData.note as string) ?? "");
    setTags((editData.tags as string) ?? "");
  }, [editData]);

  const { investmentAccounts, selectedAccount, accountHoldings } =
    useAccountHoldingSelection(accounts, holdings, accountId);

  // FINLYNQ-227 — pre-select the investment account from `?account=<id>`.
  useSeedAccountFromParam({
    isEdit,
    field: "source",
    validIds: useMemo(
      () => investmentAccounts.map((a) => a.id),
      [investmentAccounts],
    ),
    setValue: setAccountId,
  });

  const selectedHolding = useMemo(
    () =>
      holdingId
        ? accountHoldings.find((h) => String(h.id) === holdingId) ?? null
        : null,
    [holdingId, accountHoldings],
  );

  // value→label maps so base-ui Select triggers show names, not ids (FINLYNQ-197).
  const accountLabelById = useMemo(
    () =>
      Object.fromEntries(
        investmentAccounts.map((a) => [
          String(a.id),
          `${a.name ?? `#${a.id}`} (${a.currency})`,
        ]),
      ),
    [investmentAccounts],
  );
  const holdingLabelById = useMemo(
    () =>
      Object.fromEntries(
        accountHoldings.map((h) => [
          String(h.id),
          `${h.symbol ? `${h.symbol} — ` : ""}${h.name ?? `#${h.id}`} (${h.currency})`,
        ]),
      ),
    [accountHoldings],
  );

  // Cash-sleeve check: matching (account, currency, isCash=true) row must exist.
  const cashSleeve = useMemo(() => {
    if (!selectedAccount || !selectedHolding) return null;
    return (
      holdings.find(
        (h) =>
          h.accountId === selectedAccount.id &&
          !!h.isCash &&
          h.currency === selectedHolding.currency,
      ) ?? null
    );
  }, [holdings, selectedAccount, selectedHolding]);

  const cashSleeveMissing = !!selectedHolding && !cashSleeve;

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!accountId) e.accountId = "Pick an account";
    if (!holdingId) e.holdingId = "Pick a holding";
    const qtyNum = parseFloat(qty);
    if (!qty || Number.isNaN(qtyNum) || qtyNum <= 0)
      e.qty = "Quantity must be > 0";
    const costNum = parseFloat(totalCost);
    if (!totalCost || Number.isNaN(costNum) || costNum <= 0)
      e.totalCost = "Total cost must be > 0";
    if (!date) e.date = "Pick a date";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    setBlockingClosureTxIds([]);
    if (!validate()) return;
    if (cashSleeveMissing) {
      setSubmitError(
        `No ${selectedHolding?.currency} cash sleeve exists in this account.`,
      );
      return;
    }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        accountId: Number(accountId),
        holdingId: Number(holdingId),
        qty: parseFloat(qty),
        totalCost: parseFloat(totalCost),
        date,
      };
      if (payee.trim()) body.payee = payee.trim();
      if (note.trim()) body.note = note.trim();
      if (tags.trim()) body.tags = tags.trim();
      if (isEdit) body.editId = editId;
      const res = await fetch("/api/portfolio/operations/buy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data: {
          error?: string;
          code?: string;
          currency?: string;
          blockingClosureTxIds?: unknown;
        } = await res.json().catch(() => ({}));
        if (data.code === "cash_sleeve_not_found") {
          setSubmitError(
            `No ${data.currency ?? selectedHolding?.currency ?? ""} cash sleeve exists in this account. Create one via the account's Cash sleeves panel first.`,
          );
        } else if (data.code === "portfolio_edit_blocked") {
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
  if (investmentAccounts.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No investment accounts</CardTitle>
          <CardDescription>
            Buy operations require an investment account. Mark one of your
            accounts as an investment account first.
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

  const costNum = parseFloat(totalCost);
  const showPreview =
    selectedHolding && !Number.isNaN(costNum) && costNum > 0 && !!cashSleeve;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{isEdit ? "Edit Buy" : "Buy"}</CardTitle>
        <CardDescription>
          Acquire shares in an existing holding. The cash leg is debited from the
          matching {selectedHolding?.currency ?? "<currency>"} sleeve in the same
          account.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label>Account</Label>
            <Select
              items={accountLabelById}
              value={accountId}
              onValueChange={(v) => {
                setAccountId(v ?? "");
                setHoldingId("");
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Pick an investment account" />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false} side="bottom">
                {investmentAccounts.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.name ?? `#${a.id}`} ({a.currency})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.accountId && (
              <p className="text-xs text-destructive">{errors.accountId}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Holding</Label>
            <Select
              items={holdingLabelById}
              value={holdingId}
              onValueChange={(v) => setHoldingId(v ?? "")}
              disabled={!selectedAccount}
            >
              <SelectTrigger className="w-full">
                <SelectValue
                  placeholder={
                    selectedAccount
                      ? accountHoldings.length === 0
                        ? "No non-cash holdings in this account"
                        : "Pick a holding"
                      : "Pick an account first"
                  }
                />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false} side="bottom">
                {accountHoldings.map((h) => (
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
                Currently holding {Number(selectedHolding.currentShares ?? 0).toLocaleString()} shares.
              </p>
            )}
          </div>

          {cashSleeveMissing && (
            <div className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              No {selectedHolding?.currency} cash sleeve exists in this account.
              Create one in the{" "}
              <Link
                href={`/accounts/${selectedAccount?.id ?? ""}`}
                className="underline"
              >
                account page
              </Link>{" "}
              first.
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Quantity</Label>
              <Input
                type="number"
                step="any"
                inputMode="decimal"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                placeholder="100"
              />
              {errors.qty && (
                <p className="text-xs text-destructive">{errors.qty}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>
                Total cost{" "}
                {selectedHolding ? (
                  <span className="text-muted-foreground text-xs">
                    ({selectedHolding.currency})
                  </span>
                ) : null}
              </Label>
              <Input
                type="number"
                step="any"
                inputMode="decimal"
                value={totalCost}
                onChange={(e) => setTotalCost(e.target.value)}
                placeholder="1000.00"
              />
              {errors.totalCost && (
                <p className="text-xs text-destructive">{errors.totalCost}</p>
              )}
            </div>
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

          {showPreview && selectedHolding && (
            <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              Will debit the {selectedHolding.currency} cash sleeve by{" "}
              <span className="font-mono text-foreground">
                {formatCurrency(costNum, selectedHolding.currency)}
              </span>
              .
            </div>
          )}

          <div className="space-y-1.5">
            <Label>
              Payee{" "}
              <span className="text-muted-foreground text-xs">(optional)</span>
            </Label>
            <Input
              value={payee}
              onChange={(e) => setPayee(e.target.value)}
              placeholder="Broker name"
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

          <div className="space-y-1.5">
            <Label>
              Tags{" "}
              <span className="text-muted-foreground text-xs">(optional)</span>
            </Label>
            <Input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="tag1, tag2"
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
              disabled={submitting || cashSleeveMissing || !!loadError}
            >
              {submitting
                ? isEdit
                  ? "Saving…"
                  : "Recording…"
                : isEdit
                  ? "Save edit"
                  : "Record buy"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
