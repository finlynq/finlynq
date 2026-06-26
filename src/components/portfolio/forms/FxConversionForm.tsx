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

export default function FxConversionForm() {
  const router = useRouter();
  const { editId, isEdit } = useEditId();

  const { accounts, holdings, loading, loadError, editData } =
    usePortfolioFormData({ editId, opType: "fx-conversion" });

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
    if (!editData) return;
    if (editData.accountId != null) setAccountId(String(editData.accountId));
    if (editData.fromCurrency) setFromCurrency(editData.fromCurrency as string);
    if (editData.fromAmount != null) setFromAmount(String(editData.fromAmount));
    if (editData.toCurrency) setToCurrency(editData.toCurrency as string);
    if (editData.toAmount != null) setToAmount(String(editData.toAmount));
    if (typeof editData.feeAmount === "number" && editData.feeAmount > 0) {
      setFeeAmount(String(editData.feeAmount));
      // feeOnSleeveCurrency is the form's authoritative field; fall back
      // to feeCurrency if the load only returned the legacy name.
      setFeeOnSleeveCurrency(
        ((editData.feeOnSleeveCurrency ?? editData.feeCurrency) as string) ?? "",
      );
    }
    if (editData.date) setDate(editData.date as string);
    setPayee((editData.payee as string) ?? "");
    setNote((editData.note as string) ?? "");
  }, [editData]);

  const { investmentAccounts, selectedAccount } =
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

  // value→label map so the account trigger shows a name, not an id (FINLYNQ-197).
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
              items={accountLabelById}
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
                  : "Record conversion"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
