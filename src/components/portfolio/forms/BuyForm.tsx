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
import { useRouter, useSearchParams } from "next/navigation";
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

interface AccountRow {
  id: number;
  name: string | null;
  currency: string;
  alias?: string | null;
  type?: string | null;
  isInvestment?: boolean;
}

interface HoldingRow {
  id: number;
  accountId: number;
  name: string | null;
  symbol: string | null;
  currency: string;
  isCrypto: boolean | number;
  isCash: boolean | number;
  currentShares: number;
  accountName: string | null;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function BuyForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const editIdParam = searchParams.get("editId");
  const editId = editIdParam ? Number(editIdParam) : null;
  const isEdit =
    editId != null && Number.isFinite(editId) && editId > 0;

  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [holdings, setHoldings] = useState<HoldingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

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
    let cancelled = false;
    Promise.all([
      fetch("/api/accounts").then((r) => r.json()),
      fetch("/api/portfolio").then((r) => r.json()),
    ])
      .then(([acc, holds]) => {
        if (cancelled) return;
        setAccounts(Array.isArray(acc) ? acc : []);
        setHoldings(Array.isArray(holds) ? holds : []);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : "Failed to load data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load existing operation data on mount when editId is present.
  useEffect(() => {
    if (!isEdit) return;
    let cancelled = false;
    fetch(`/api/portfolio/operations/load?id=${editId}`)
      .then(async (r) => {
        if (cancelled) return;
        const json: {
          error?: string;
          data?: {
            op?: string;
            accountId?: number;
            holdingId?: number;
            qty?: number;
            totalCost?: number;
            date?: string;
            payee?: string | null;
            note?: string | null;
            tags?: string | null;
          };
        } = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok) {
          setLoadError(
            json.error ?? `Failed to load edit data (${r.status})`,
          );
          return;
        }
        const d = json.data;
        if (!d) {
          setLoadError("Failed to load edit data (empty response)");
          return;
        }
        if (d.op !== "buy") {
          setLoadError(
            `This edit link is for "${d.op}" — use that form instead.`,
          );
          return;
        }
        if (d.accountId != null) setAccountId(String(d.accountId));
        if (d.holdingId != null) setHoldingId(String(d.holdingId));
        if (d.qty != null) setQty(String(d.qty));
        if (d.totalCost != null) setTotalCost(String(d.totalCost));
        if (d.date) setDate(d.date);
        setPayee(d.payee ?? "");
        setNote(d.note ?? "");
        setTags(d.tags ?? "");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setLoadError(
          e instanceof Error ? e.message : "Failed to load edit data",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [editId, isEdit]);

  const investmentAccounts = useMemo(
    () => accounts.filter((a) => a.isInvestment === true),
    [accounts],
  );

  const selectedAccount = useMemo(
    () =>
      accountId
        ? investmentAccounts.find((a) => String(a.id) === accountId) ?? null
        : null,
    [accountId, investmentAccounts],
  );

  const accountHoldings = useMemo(
    () =>
      selectedAccount
        ? holdings.filter(
            (h) => h.accountId === selectedAccount.id && !h.isCash,
          )
        : [],
    [holdings, selectedAccount],
  );

  const selectedHolding = useMemo(
    () =>
      holdingId
        ? accountHoldings.find((h) => String(h.id) === holdingId) ?? null
        : null,
    [holdingId, accountHoldings],
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
                      href={`/transactions?search=%23${id}`}
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
