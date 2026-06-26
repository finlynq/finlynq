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

type Direction = "income" | "expense";

export default function IncomeExpenseForm() {
  const router = useRouter();
  const { editId, isEdit } = useEditId();

  const { accounts, holdings, categories, loading, loadError, editData } =
    usePortfolioFormData({ editId, opType: "income-expense", includeCategories: true });

  const [accountId, setAccountId] = useState<string>("");
  const [currency, setCurrency] = useState<string>("");
  const [direction, setDirection] = useState<Direction>("income");
  // Settle into: "cash" (the cash sleeve, legacy) or "shares" (a holding —
  // income received as shares, single-leg DRIP). Income-only + create-only.
  const [settleAs, setSettleAs] = useState<"cash" | "shares">("cash");
  const [quantity, setQuantity] = useState<string>("");
  const [amount, setAmount] = useState<string>("");
  const [relatedHoldingId, setRelatedHoldingId] = useState<string>("");
  // Entry type drives auto-categorization. A preset (dividend/interest/fee)
  // resolves-or-creates its canonical category server-side; "other" falls back
  // to the manual category picker below.
  const [incomeType, setIncomeType] = useState<
    "dividend" | "interest" | "fee" | "other"
  >("dividend");
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
    if (!editData) return;
    if (editData.accountId != null) setAccountId(String(editData.accountId));
    if (editData.currency) setCurrency(editData.currency as string);
    if (typeof editData.amount === "number") {
      setDirection(editData.amount < 0 ? "expense" : "income");
      setAmount(String(Math.abs(editData.amount)));
    }
    if (editData.relatedHoldingId != null)
      setRelatedHoldingId(String(editData.relatedHoldingId));
    // Editing an existing row: keep its category exactly as-is via the
    // manual picker — don't re-infer a preset and silently re-tag.
    setIncomeType("other");
    if (editData.categoryId != null) setCategoryId(String(editData.categoryId));
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
  const relatedHoldingLabelById = useMemo(
    () =>
      Object.fromEntries(
        accountHoldings.map((h) => [
          String(h.id),
          `${h.symbol ? `${h.symbol} — ` : ""}${h.name ?? `#${h.id}`}`,
        ]),
      ),
    [accountHoldings],
  );
  const categoryLabelById = useMemo(
    () =>
      Object.fromEntries(
        categories.map((c) => [
          String(c.id),
          `${c.name ?? `#${c.id}`}${c.group ? ` (${c.group})` : ""}`,
        ]),
      ),
    [categories],
  );
  // Direction and entry-type enum→label maps (value differs from displayed text).
  const directionLabels: Record<string, string> = {
    income: "Income (+)",
    expense: "Expense (−)",
  };
  // incomeType labels depend on direction context; cover the full set to
  // handle both directions without re-computing on direction change.
  const incomeTypeLabels: Record<string, string> = {
    dividend: "Dividend",
    interest: "Interest",
    fee: "Fee",
    other: direction === "income" ? "Other income" : "Other expense",
  };

  // Income-as-shares is income-only and create-only: hidden in edit mode and
  // for expenses. The toggle below is only shown under the same condition.
  const sharesAllowed = !isEdit && direction === "income";
  const sharesMode = sharesAllowed && settleAs === "shares";

  // Implied price/share preview for shares mode (cosmetic).
  const impliedPricePerShare = useMemo(() => {
    const q = parseFloat(quantity);
    const v = parseFloat(amount);
    if (!q || !v || Number.isNaN(q) || Number.isNaN(v) || q <= 0) return null;
    return v / q;
  }, [quantity, amount]);

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!accountId) e.accountId = "Pick an account";
    const amt = parseFloat(amount);
    if (!amount || Number.isNaN(amt) || amt <= 0)
      e.amount = sharesMode ? "Value must be > 0" : "Amount must be > 0";
    if (sharesMode) {
      if (!relatedHoldingId)
        e.relatedHoldingId = "Pick a holding to receive shares";
      const q = parseFloat(quantity);
      if (!quantity || Number.isNaN(q) || q <= 0)
        e.quantity = "Quantity must be > 0";
    } else {
      if (!currency) e.currency = "Pick a currency / cash sleeve";
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
      const positive = parseFloat(amount);
      const body: Record<string, unknown> = {
        accountId: Number(accountId),
        date,
      };
      if (sharesMode) {
        // Single-leg DRIP: income lands as shares on the chosen holding.
        // Value is always positive; quantity = shares; no currency (derived
        // from the holding server-side).
        body.settleAs = "shares";
        body.holdingId = Number(relatedHoldingId);
        body.quantity = parseFloat(quantity);
        body.amount = positive;
      } else {
        // Cash sleeve: positive = income, negative = expense.
        body.currency = currency;
        body.amount = direction === "income" ? positive : -positive;
        if (relatedHoldingId) body.relatedHoldingId = Number(relatedHoldingId);
      }
      // Preset entry types auto-resolve the category server-side; "other" uses
      // the manually-picked category. An explicit categoryId always wins on the
      // server, so for presets we deliberately omit it.
      if (incomeType === "other") {
        if (categoryId) body.categoryId = Number(categoryId);
      } else {
        body.incomeType = incomeType;
      }
      if (payee.trim()) body.payee = payee.trim();
      if (note.trim()) body.note = note.trim();
      if (tags.trim()) body.tags = tags.trim();
      if (isEdit && !sharesMode) body.editId = editId;
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
          income to a specific position for reporting. For income received as
          shares (a DRIP), switch &ldquo;Settle into&rdquo; to{" "}
          <span className="font-medium">Holding (shares)</span> to book it in a
          single entry.
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
                items={directionLabels}
                value={direction}
                onValueChange={(v) => {
                  const d = (v ?? "income") as Direction;
                  setDirection(d);
                  // Reset the entry-type preset to the sensible default for the
                  // new sign (income→dividend, expense→fee).
                  setIncomeType(d === "income" ? "dividend" : "fee");
                  // Income-as-shares is income-only — drop back to cash for an
                  // expense so the form stays consistent.
                  if (d === "expense") setSettleAs("cash");
                }}
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
            {sharesMode ? (
              <div className="space-y-1.5">
                <Label>Quantity (shares)</Label>
                <Input
                  type="number"
                  step="any"
                  inputMode="decimal"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  placeholder="e.g. 1.2345"
                />
                {errors.quantity && (
                  <p className="text-xs text-destructive">{errors.quantity}</p>
                )}
              </div>
            ) : (
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
            )}
          </div>

          {sharesAllowed && (
            <div className="space-y-1.5">
              <Label>Settle into</Label>
              <Select
                items={{
                  cash: "Cash sleeve",
                  shares: "Holding (shares)",
                }}
                value={settleAs}
                onValueChange={(v) =>
                  setSettleAs((v ?? "cash") as "cash" | "shares")
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false} side="bottom">
                  <SelectItem value="cash">Cash sleeve</SelectItem>
                  <SelectItem value="shares">Holding (shares)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {settleAs === "shares"
                  ? "Dividend/income received AS SHARES — books one entry that adds shares to a holding (cost basis = value ÷ quantity). No cash sleeve is touched."
                  : "Income lands as cash on the matching cash sleeve."}
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Entry type</Label>
            <Select
              items={incomeTypeLabels}
              value={incomeType}
              onValueChange={(v) =>
                setIncomeType(
                  (v ?? "other") as "dividend" | "interest" | "fee" | "other",
                )
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false} side="bottom">
                {direction === "income" ? (
                  <>
                    <SelectItem value="dividend">Dividend</SelectItem>
                    <SelectItem value="interest">Interest</SelectItem>
                    <SelectItem value="other">Other income</SelectItem>
                  </>
                ) : (
                  <>
                    <SelectItem value="fee">Fee</SelectItem>
                    <SelectItem value="other">Other expense</SelectItem>
                  </>
                )}
              </SelectContent>
            </Select>
            {incomeType !== "other" && (
              <p className="text-xs text-muted-foreground">
                Auto-categorized as{" "}
                <span className="font-medium">
                  {incomeType === "dividend"
                    ? "Dividends"
                    : incomeType === "interest"
                      ? "Interest"
                      : "Investment Fees"}
                </span>{" "}
                so it shows in the right report (the category is created if you
                don&apos;t have it yet). Choose &ldquo;Other&rdquo; to pick a
                category manually.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>
                {sharesMode ? "Dollar value" : "Amount"}{" "}
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
              {sharesMode ? (
                "Holding to receive shares"
              ) : (
                <>
                  Related holding{" "}
                  <span className="text-muted-foreground text-xs">
                    (optional)
                  </span>
                </>
              )}
            </Label>
            <Select
              items={relatedHoldingLabelById}
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
                        : sharesMode
                          ? "Pick the holding the shares land on"
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
            {sharesMode && errors.relatedHoldingId && (
              <p className="text-xs text-destructive">
                {errors.relatedHoldingId}
              </p>
            )}
            {sharesMode && impliedPricePerShare != null && (
              <p className="text-xs text-muted-foreground">
                ≈ {impliedPricePerShare.toLocaleString(undefined, {
                  maximumFractionDigits: 6,
                })}{" "}
                per share
              </p>
            )}
          </div>

          {incomeType === "other" && (
            <div className="space-y-1.5">
              <Label>
                Category{" "}
                <span className="text-muted-foreground text-xs">(optional)</span>
              </Label>
              <Select
                items={categoryLabelById}
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
          )}

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
                  : sharesMode
                    ? "Record income (shares)"
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
