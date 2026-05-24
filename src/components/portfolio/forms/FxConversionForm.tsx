"use client";

/**
 * FxConversionForm — convert one cash sleeve to another inside a single
 * investment account.
 *
 * POST /api/portfolio/operations/fx-conversion:
 *   pick account → from currency + amount → to currency + amount → optional fee.
 *
 * Source the from/to currency lists from the existing cash sleeves on the
 * selected account (you can't fx-convert to a sleeve you don't have).
 * The inferred rate (toAmount / fromAmount) is shown read-only.
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

export default function FxConversionForm() {
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
  const [fromCurrency, setFromCurrency] = useState<string>("");
  const [fromAmount, setFromAmount] = useState<string>("");
  const [toCurrency, setToCurrency] = useState<string>("");
  const [toAmount, setToAmount] = useState<string>("");
  const [feeAmount, setFeeAmount] = useState<string>("");
  const [feeOnSleeveCurrency, setFeeOnSleeveCurrency] = useState<string>("");
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
            accountId?: number;
            fromCurrency?: string;
            fromAmount?: number;
            toCurrency?: string;
            toAmount?: number;
            feeAmount?: number | null;
            feeCurrency?: string | null;
            feeOnSleeveCurrency?: string | null;
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
        if (d.op !== "fx-conversion") {
          setLoadError(
            `This edit link is for "${d.op}" — use that form instead.`,
          );
          return;
        }
        if (d.accountId != null) setAccountId(String(d.accountId));
        if (d.fromCurrency) setFromCurrency(d.fromCurrency);
        if (d.fromAmount != null) setFromAmount(String(d.fromAmount));
        if (d.toCurrency) setToCurrency(d.toCurrency);
        if (d.toAmount != null) setToAmount(String(d.toAmount));
        if (d.feeAmount != null && d.feeAmount > 0) {
          setFeeAmount(String(d.feeAmount));
          // feeOnSleeveCurrency is the form's authoritative field; fall back
          // to feeCurrency if the load only returned the legacy name.
          setFeeOnSleeveCurrency(
            d.feeOnSleeveCurrency ?? d.feeCurrency ?? "",
          );
        }
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

  const selectedAccount = useMemo(
    () =>
      accountId
        ? investmentAccounts.find((a) => String(a.id) === accountId) ?? null
        : null,
    [accountId, investmentAccounts],
  );

  const cashSleeves = useMemo(
    () =>
      selectedAccount
        ? holdings.filter(
            (h) => h.accountId === selectedAccount.id && !!h.isCash,
          )
        : [],
    [holdings, selectedAccount],
  );

  // Distinct currencies (one sleeve per currency is the norm but defensive).
  const sleeveCurrencies = useMemo(() => {
    const set = new Set<string>();
    for (const s of cashSleeves) set.add(s.currency);
    return Array.from(set);
  }, [cashSleeves]);

  const toCurrencyOptions = useMemo(
    () => sleeveCurrencies.filter((c) => c !== fromCurrency),
    [sleeveCurrencies, fromCurrency],
  );

  const inferredRate = useMemo(() => {
    const from = parseFloat(fromAmount);
    const to = parseFloat(toAmount);
    if (Number.isNaN(from) || Number.isNaN(to) || from <= 0) return null;
    return to / from;
  }, [fromAmount, toAmount]);

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!accountId) e.accountId = "Pick an account";
    if (!fromCurrency) e.fromCurrency = "Pick a from currency";
    if (!toCurrency) e.toCurrency = "Pick a to currency";
    if (fromCurrency && toCurrency && fromCurrency === toCurrency) {
      e.toCurrency = "From and to must differ";
    }
    const fAmt = parseFloat(fromAmount);
    if (!fromAmount || Number.isNaN(fAmt) || fAmt <= 0)
      e.fromAmount = "From amount must be > 0";
    const tAmt = parseFloat(toAmount);
    if (!toAmount || Number.isNaN(tAmt) || tAmt <= 0)
      e.toAmount = "To amount must be > 0";
    if (feeAmount.trim()) {
      const feeNum = parseFloat(feeAmount);
      if (Number.isNaN(feeNum) || feeNum <= 0)
        e.feeAmount = "Fee must be > 0 or empty";
    }
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
        accountId: Number(accountId),
        fromCurrency,
        fromAmount: parseFloat(fromAmount),
        toCurrency,
        toAmount: parseFloat(toAmount),
        date,
      };
      if (feeAmount.trim()) {
        const feeNum = parseFloat(feeAmount);
        if (!Number.isNaN(feeNum) && feeNum > 0) {
          body.feeAmount = feeNum;
          // Default the fee sleeve to the from-currency when the user
          // doesn't pick one — matches the server's resolve order.
          body.feeOnSleeveCurrency = feeOnSleeveCurrency || fromCurrency;
          body.feeCurrency = feeOnSleeveCurrency || fromCurrency;
        }
      }
      if (payee.trim()) body.payee = payee.trim();
      if (note.trim()) body.note = note.trim();
      if (isEdit) body.editId = editId;
      const res = await fetch("/api/portfolio/operations/fx-conversion", {
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
            `No ${data.currency ?? ""} cash sleeve exists in this account. Create one via the account's Cash sleeves panel first.`,
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
            FX conversions require an investment account with multi-currency
            cash sleeves.
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
        <CardTitle>{isEdit ? "Edit FX conversion" : "FX conversion"}</CardTitle>
        <CardDescription>
          Move cash between two currency sleeves in the same account. Inferred
          rate = to / from. Optional fee deducts from a chosen sleeve.
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
                setFromCurrency("");
                setToCurrency("");
                setFeeOnSleeveCurrency("");
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

          {selectedAccount && sleeveCurrencies.length < 2 && (
            <div className="rounded-md border border-amber-500/50 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              This account has fewer than 2 cash sleeves. Add another currency
              sleeve in the{" "}
              <Link
                href={`/accounts/${selectedAccount.id}`}
                className="underline"
              >
                account page
              </Link>{" "}
              before converting.
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>From currency</Label>
              <Select
                value={fromCurrency}
                onValueChange={(v) => {
                  setFromCurrency(v ?? "");
                  if (v && v === toCurrency) setToCurrency("");
                }}
                disabled={!selectedAccount || sleeveCurrencies.length === 0}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Pick" />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false} side="bottom">
                  {sleeveCurrencies.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.fromCurrency && (
                <p className="text-xs text-destructive">{errors.fromCurrency}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>
                From amount{" "}
                {fromCurrency ? (
                  <span className="text-muted-foreground text-xs">
                    ({fromCurrency})
                  </span>
                ) : null}
              </Label>
              <Input
                type="number"
                step="any"
                inputMode="decimal"
                value={fromAmount}
                onChange={(e) => setFromAmount(e.target.value)}
                placeholder="100.00"
              />
              {errors.fromAmount && (
                <p className="text-xs text-destructive">{errors.fromAmount}</p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>To currency</Label>
              <Select
                value={toCurrency}
                onValueChange={(v) => setToCurrency(v ?? "")}
                disabled={!fromCurrency || toCurrencyOptions.length === 0}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Pick" />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false} side="bottom">
                  {toCurrencyOptions.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.toCurrency && (
                <p className="text-xs text-destructive">{errors.toCurrency}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>
                To amount{" "}
                {toCurrency ? (
                  <span className="text-muted-foreground text-xs">
                    ({toCurrency})
                  </span>
                ) : null}
              </Label>
              <Input
                type="number"
                step="any"
                inputMode="decimal"
                value={toAmount}
                onChange={(e) => setToAmount(e.target.value)}
                placeholder="73.50"
              />
              {errors.toAmount && (
                <p className="text-xs text-destructive">{errors.toAmount}</p>
              )}
            </div>
          </div>

          {inferredRate !== null && fromCurrency && toCurrency && (
            <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              Inferred rate:{" "}
              <span className="font-mono text-foreground">
                1 {fromCurrency} = {inferredRate.toFixed(6)} {toCurrency}
              </span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>
                Fee amount{" "}
                <span className="text-muted-foreground text-xs">
                  (optional)
                </span>
              </Label>
              <Input
                type="number"
                step="any"
                inputMode="decimal"
                value={feeAmount}
                onChange={(e) => setFeeAmount(e.target.value)}
                placeholder="0.00"
              />
              {errors.feeAmount && (
                <p className="text-xs text-destructive">{errors.feeAmount}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Fee charged to sleeve</Label>
              <Select
                value={feeOnSleeveCurrency}
                onValueChange={(v) => setFeeOnSleeveCurrency(v ?? "")}
                disabled={!feeAmount.trim() || sleeveCurrencies.length === 0}
              >
                <SelectTrigger className="w-full">
                  <SelectValue
                    placeholder={
                      feeAmount.trim()
                        ? "Default = from currency"
                        : "Enter fee first"
                    }
                  />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false} side="bottom">
                  {sleeveCurrencies.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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

          <div className="space-y-1.5">
            <Label>
              Payee{" "}
              <span className="text-muted-foreground text-xs">(optional)</span>
            </Label>
            <Input
              value={payee}
              onChange={(e) => setPayee(e.target.value)}
              placeholder="e.g. Norbert's Gambit"
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
                  : "Record conversion"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
