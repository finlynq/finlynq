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

export default function TransferForm() {
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
            sourceAccountId?: number;
            destAccountId?: number;
            holdingId?: number;
            qty?: number;
            date?: string;
            payee?: string | null;
            note?: string | null;
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
        if (d.op !== "transfer") {
          setLoadError(
            `This edit link is for "${d.op}" — use that form instead.`,
          );
          return;
        }
        if (d.sourceAccountId != null)
          setSourceAccountId(String(d.sourceAccountId));
        if (d.destAccountId != null)
          setDestAccountId(String(d.destAccountId));
        if (d.holdingId != null) setHoldingId(String(d.holdingId));
        if (d.qty != null) setQty(String(d.qty));
        if (d.date) setDate(d.date);
        setPayee(d.payee ?? "");
        setNote(d.note ?? "");
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

  const sourceAccount = useMemo(
    () =>
      sourceAccountId
        ? investmentAccounts.find((a) => String(a.id) === sourceAccountId) ??
          null
        : null,
    [sourceAccountId, investmentAccounts],
  );

  const destAccountOptions = useMemo(
    () =>
      investmentAccounts.filter((a) => String(a.id) !== sourceAccountId),
    [investmentAccounts, sourceAccountId],
  );

  const sourceHoldings = useMemo(
    () =>
      sourceAccount
        ? holdings.filter(
            (h) => h.accountId === sourceAccount.id && !h.isCash,
          )
        : [],
    [holdings, sourceAccount],
  );

  const selectedHolding = useMemo(
    () =>
      holdingId
        ? sourceHoldings.find((h) => String(h.id) === holdingId) ?? null
        : null,
    [holdingId, sourceHoldings],
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
