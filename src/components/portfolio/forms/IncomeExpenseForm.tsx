"use client";

/**
 * IncomeExpenseForm — portfolio dividends/interest (income) or fees (expense).
 *
 * POST /api/portfolio/operations/income-expense:
 *   pick account → pick cash sleeve currency → toggle income/expense + amount
 *   optional: relatedHoldingId (for attribution), categoryId.
 *
 * Sign convention: positive amount = income, negative = expense. We always
 * collect a positive number from the user and negate when "Expense" is
 * selected — simpler UX than asking them to think in signs.
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

interface CategoryRow {
  id: number;
  name: string | null;
  type?: string | null;
  group?: string | null;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

type Direction = "income" | "expense";

export default function IncomeExpenseForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const editIdParam = searchParams.get("editId");
  const editId = editIdParam ? Number(editIdParam) : null;
  const isEdit =
    editId != null && Number.isFinite(editId) && editId > 0;

  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [holdings, setHoldings] = useState<HoldingRow[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [accountId, setAccountId] = useState<string>("");
  const [currency, setCurrency] = useState<string>("");
  const [direction, setDirection] = useState<Direction>("income");
  const [amount, setAmount] = useState<string>("");
  const [relatedHoldingId, setRelatedHoldingId] = useState<string>("");
  const [categoryId, setCategoryId] = useState<string>("");
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
      // Categories are optional — swallow errors so the form still loads.
      fetch("/api/categories")
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => []),
    ])
      .then(([acc, holds, cats]) => {
        if (cancelled) return;
        setAccounts(Array.isArray(acc) ? acc : []);
        setHoldings(Array.isArray(holds) ? holds : []);
        setCategories(Array.isArray(cats) ? cats : []);
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
            currency?: string;
            amount?: number;
            relatedHoldingId?: number | null;
            categoryId?: number | null;
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
        if (d.op !== "income-expense") {
          setLoadError(
            `This edit link is for "${d.op}" — use that form instead.`,
          );
          return;
        }
        if (d.accountId != null) setAccountId(String(d.accountId));
        if (d.currency) setCurrency(d.currency);
        if (typeof d.amount === "number") {
          setDirection(d.amount < 0 ? "expense" : "income");
          setAmount(String(Math.abs(d.amount)));
        }
        if (d.relatedHoldingId != null)
          setRelatedHoldingId(String(d.relatedHoldingId));
        if (d.categoryId != null) setCategoryId(String(d.categoryId));
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

  // Source currency list from cash sleeves on the selected account.
  const cashSleeves = useMemo(
    () =>
      selectedAccount
        ? holdings.filter(
            (h) => h.accountId === selectedAccount.id && !!h.isCash,
          )
        : [],
    [holdings, selectedAccount],
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

  // Auto-default currency to the account's currency when changing accounts
  // (or to the first sleeve if the account currency lacks a sleeve).
  useEffect(() => {
    if (!selectedAccount) {
      setCurrency("");
      return;
    }
    setCurrency((prev) => {
      const stillValid = cashSleeves.some((s) => s.currency === prev);
      if (stillValid) return prev;
      const matchAcct = cashSleeves.find(
        (s) => s.currency === selectedAccount.currency,
      );
      return matchAcct?.currency ?? cashSleeves[0]?.currency ?? "";
    });
  }, [selectedAccount, cashSleeves]);

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!accountId) e.accountId = "Pick an account";
    if (!currency) e.currency = "Pick a currency / cash sleeve";
    const amt = parseFloat(amount);
    if (!amount || Number.isNaN(amt) || amt <= 0)
      e.amount = "Amount must be > 0";
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
      const positive = parseFloat(amount);
      const signed = direction === "income" ? positive : -positive;
      const body: Record<string, unknown> = {
        accountId: Number(accountId),
        currency,
        amount: signed,
        date,
      };
      if (relatedHoldingId) body.relatedHoldingId = Number(relatedHoldingId);
      if (categoryId) body.categoryId = Number(categoryId);
      if (payee.trim()) body.payee = payee.trim();
      if (note.trim()) body.note = note.trim();
      if (tags.trim()) body.tags = tags.trim();
      if (isEdit) body.editId = editId;
      const res = await fetch("/api/portfolio/operations/income-expense", {
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
            `No ${data.currency ?? currency} cash sleeve exists in this account. Create one via the account's Cash sleeves panel first.`,
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
            Portfolio income/expense requires an investment account.
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
          {isEdit
            ? "Edit Income / expense"
            : "Portfolio income / expense"}
        </CardTitle>
        <CardDescription>
          Dividends and interest land as income on the matching cash sleeve;
          custodial fees land as expenses. Pick a related holding to attribute
          income to a specific position for reporting.
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
                setRelatedHoldingId("");
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

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Direction</Label>
              <Select
                value={direction}
                onValueChange={(v) => setDirection((v ?? "income") as Direction)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false} side="bottom">
                  <SelectItem value="income">Income (+)</SelectItem>
                  <SelectItem value="expense">Expense (−)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Currency / cash sleeve</Label>
              <Select
                value={currency}
                onValueChange={(v) => setCurrency(v ?? "")}
                disabled={!selectedAccount || cashSleeves.length === 0}
              >
                <SelectTrigger className="w-full">
                  <SelectValue
                    placeholder={
                      selectedAccount && cashSleeves.length === 0
                        ? "No cash sleeves on this account"
                        : "Pick a sleeve"
                    }
                  />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false} side="bottom">
                  {cashSleeves.map((s) => (
                    <SelectItem key={s.id} value={s.currency}>
                      {s.currency}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.currency && (
                <p className="text-xs text-destructive">{errors.currency}</p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>
                Amount{" "}
                <span className="text-muted-foreground text-xs">
                  (positive)
                </span>
              </Label>
              <Input
                type="number"
                step="any"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="25.00"
              />
              {errors.amount && (
                <p className="text-xs text-destructive">{errors.amount}</p>
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
              Related holding{" "}
              <span className="text-muted-foreground text-xs">(optional)</span>
            </Label>
            <Select
              value={relatedHoldingId}
              onValueChange={(v) => setRelatedHoldingId(v ?? "")}
              disabled={!selectedAccount || accountHoldings.length === 0}
            >
              <SelectTrigger className="w-full">
                <SelectValue
                  placeholder={
                    selectedAccount
                      ? accountHoldings.length === 0
                        ? "No non-cash holdings"
                        : "Pick a holding for attribution"
                      : "Pick an account first"
                  }
                />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false} side="bottom">
                {accountHoldings.map((h) => (
                  <SelectItem key={h.id} value={String(h.id)}>
                    {h.symbol ? `${h.symbol} — ` : ""}
                    {h.name ?? `#${h.id}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>
              Category{" "}
              <span className="text-muted-foreground text-xs">(optional)</span>
            </Label>
            <Select
              value={categoryId}
              onValueChange={(v) => setCategoryId(v ?? "")}
              disabled={categories.length === 0}
            >
              <SelectTrigger className="w-full">
                <SelectValue
                  placeholder={
                    categories.length === 0
                      ? "No categories available"
                      : "Pick a category (e.g. Dividends)"
                  }
                />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false} side="bottom">
                {categories.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.name ?? `#${c.id}`}
                    {c.group ? ` (${c.group})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>
              Payee{" "}
              <span className="text-muted-foreground text-xs">(optional)</span>
            </Label>
            <Input
              value={payee}
              onChange={(e) => setPayee(e.target.value)}
              placeholder="e.g. Quarterly dividend"
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
              disabled={submitting || !!loadError}
            >
              {submitting
                ? isEdit
                  ? "Saving…"
                  : "Recording…"
                : isEdit
                  ? "Save edit"
                  : direction === "income"
                    ? "Record income"
                    : "Record expense"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
