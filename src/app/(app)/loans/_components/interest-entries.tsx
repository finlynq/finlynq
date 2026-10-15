"use client";

/**
 * "Interest entries" tab of a loan's schedule panel (2026-10-12).
 *
 * A loan payment is a plain transfer into the loan account. The interest is a
 * separate expense transaction on that same account. This panel reads the
 * account for interest already booked — typed in by hand, recorded by an
 * assistant, or generated here, they all count — sets each amount beside the
 * schedule's calculated figure, and can generate the entry for any payment
 * date that has none. The amount is editable for a lender whose figure differs
 * from the calculated one.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Combobox, type ComboboxItemShape } from "@/components/ui/combobox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCurrency } from "@/lib/currency";
import { parseSaveError } from "@/lib/save-error";
import { todayISO } from "@/lib/utils/date";
import { buildTxDrillUrl } from "@/lib/transactions/drill-url";
import {
  ASSESSMENT_MAX_PERIODS,
  assessBookedInterest,
  dueUnpostedInterest,
  matchInterestToSchedule,
  type InterestScheduleRow,
  type InterestTx,
} from "@/lib/loans/interest-plan";

type Category = { id: number; name: string; type: string };

export function LoanInterestEntries({
  loan,
  schedule,
  rateDriven = true,
  onPosted,
  onRateChanged,
}: {
  loan: {
    id: number;
    currency: string;
    annualRate: number;
    accountId: number | null;
    accountName: string | null;
  };
  schedule: InterestScheduleRow[];
  /** False for a manual schedule: its interest is not derived from the rate, so no rate is suggested. */
  rateDriven?: boolean;
  /** Called after entries are created, so the page can refresh the loan's balance. */
  onPosted?: () => void;
  /** Called after the suggested rate is saved, so the page can rebuild the schedule. */
  onRateChanged?: (annualRate: number) => void;
}) {
  const [entries, setEntries] = useState<InterestTx[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoryId, setCategoryId] = useState("");
  // Per-period amount edits, keyed by the schedule row's date.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // The suggested rate awaiting confirmation, or null when the dialog is closed.
  const [rateToApply, setRateToApply] = useState<number | null>(null);
  const [rateSaving, setRateSaving] = useState(false);
  // Making the interest category from here: the picker only lists existing
  // categories, and a first loan usually has none to pick.
  const [creating, setCreating] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("Loan interest");
  const [creatingBusy, setCreatingBusy] = useState(false);

  // `category` previews the ledger under that category; "" uses the loan's own.
  const load = useCallback(
    async (category: string) => {
      try {
        const qs = category ? `&categoryId=${category}` : "";
        const res = await fetch(`/api/loans/interest?loanId=${loan.id}${qs}`);
        const data = res.ok ? (await res.json())?.data : null;
        setEntries(Array.isArray(data?.entries) ? data.entries : []);
        return data?.interestCategoryId != null ? String(data.interestCategoryId) : "";
      } catch {
        setEntries([]);
        return "";
      } finally {
        setLoaded(true);
      }
    },
    [loan.id],
  );

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setEdits({});
    setError("");
    (async () => {
      const [saved, cats] = await Promise.all([
        load(""),
        fetch("/api/categories")
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => []),
      ]);
      if (cancelled) return;
      const expense = (Array.isArray(cats) ? (cats as Category[]) : []).filter((c) => c.type === "E");
      setCategories(expense);
      if (saved) {
        setCategoryId(saved);
        return;
      }
      // No category saved on this loan yet: start from one that already says
      // "interest", and show what the ledger holds under it.
      const guess = expense.find((c) => /interest/i.test(c.name ?? ""));
      if (guess) {
        setCategoryId(String(guess.id));
        await load(String(guess.id));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function pickCategory(value: string) {
    setCategoryId(value);
    setError("");
    if (!value) return;
    await load(value);
    // Remember it, so interest entered by hand under this category is
    // recognised next time without picking again. Best-effort.
    void fetch("/api/loans/interest", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loanId: loan.id, categoryId: Number(value) }),
    }).catch(() => {});
  }

  async function createCategory() {
    const name = newCategoryName.trim();
    if (!name || creatingBusy) return;
    setCreatingBusy(true);
    setError("");
    try {
      const res = await fetch("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, type: "E", group: "Financial" }),
      });
      if (!res.ok) {
        setError(await parseSaveError(res, "Could not create the category."));
        return;
      }
      const created = await res.json().catch(() => null);
      const id = Number(created?.id);
      if (!Number.isInteger(id) || id <= 0) {
        setError("Could not create the category.");
        return;
      }
      setCategories((cur) => [...cur, { id, name, type: "E" }]);
      setCreating(false);
      await pickCategory(String(id));
    } catch {
      setError("Could not reach the server. Nothing was saved.");
    } finally {
      setCreatingBusy(false);
    }
  }

  const today = todayISO();
  const { booked, unmatched } = useMemo(
    () => matchInterestToSchedule(schedule, entries),
    [schedule, entries],
  );
  const due = useMemo(
    () => dueUnpostedInterest(schedule, new Set(booked.keys()), today),
    [schedule, booked, today],
  );
  const assessment = useMemo(
    () => assessBookedInterest(schedule, booked, today, rateDriven ? loan.annualRate : 0),
    [schedule, booked, today, loan.annualRate, rateDriven],
  );
  // Everything that has come due, newest first, plus the next upcoming payment
  // so a user booking slightly ahead of the due date can still do it.
  const rows = useMemo(() => {
    const past = schedule.filter((r) => r.date <= today);
    const next = schedule.find((r) => r.date > today);
    return (next ? [...past, next] : past).slice().reverse();
  }, [schedule, today]);

  const amountFor = (r: InterestScheduleRow): number => {
    const raw = edits[r.date];
    if (raw === undefined) return r.interest;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : NaN;
  };

  async function post(target: InterestScheduleRow[]) {
    if (saving) return;
    if (!categoryId) {
      setError("Pick the category to book the interest under.");
      return;
    }
    const payload = target.map((r) => ({ periodDate: r.date, amount: amountFor(r) }));
    if (payload.some((e) => !Number.isFinite(e.amount) || e.amount < 0.01)) {
      setError("Each interest amount must be at least 0.01.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/loans/interest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loanId: loan.id, categoryId: Number(categoryId), entries: payload }),
      });
      if (!res.ok) {
        setError(await parseSaveError(res, "Could not create the interest entry."));
        // Someone may have booked it meanwhile; show what the ledger has now.
        await load(categoryId);
        return;
      }
      setEdits({});
      await load(categoryId);
      onPosted?.();
    } catch {
      setError("Could not reach the server. Nothing was saved.");
    } finally {
      setSaving(false);
    }
  }

  async function applyRate() {
    if (rateToApply == null || rateSaving) return;
    setRateSaving(true);
    setError("");
    try {
      const res = await fetch("/api/loans", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: loan.id, annualRate: rateToApply }),
      });
      if (!res.ok) {
        setError(await parseSaveError(res, "Could not change the rate."));
        return;
      }
      onRateChanged?.(rateToApply);
    } catch {
      setError("Could not reach the server. The rate was not changed.");
    } finally {
      setRateSaving(false);
      setRateToApply(null);
    }
  }

  if (loan.accountId == null) {
    return (
      <p className="text-sm text-muted-foreground">
        Link this loan to an account (Edit, then Linked account) to book its interest. Interest is
        recorded as an expense on the loan&apos;s own account, so the account is where it has to go.
      </p>
    );
  }

  const dueTotal = due.reduce((s, r) => s + (Number.isFinite(amountFor(r)) ? amountFor(r) : 0), 0);
  const entriesUrl = (ids: number[]) =>
    ids.length === 1
      ? buildTxDrillUrl({ id: String(ids[0]) })
      : buildTxDrillUrl({ accountId: String(loan.accountId), categoryId });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Record each payment as a plain transfer into{" "}
        <span className="font-medium text-foreground">{loan.accountName ?? "the loan account"}</span>.
        The interest is a separate expense on that same account, so the balance falls by the
        principal only and the interest shows in your reports. Interest you entered yourself under
        the category below is picked up here too.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-64">
          <Label className="mb-1 block text-xs text-muted-foreground">Interest category</Label>
          <Combobox
            value={categoryId}
            onValueChange={(v) => void pickCategory(v)}
            items={categories.map((c): ComboboxItemShape => ({ value: String(c.id), label: c.name }))}
            placeholder="Pick an expense category"
          />
        </div>
        {!creating && (
          <Button variant="outline" onClick={() => { setCreating(true); setError(""); }}>
            New category
          </Button>
        )}
        <Button onClick={() => post(due)} disabled={saving || !loaded || due.length === 0}>
          {due.length === 0
            ? "Nothing due"
            : `Generate ${due.length} due ${due.length === 1 ? "entry" : "entries"} (${formatCurrency(dueTotal, loan.currency)})`}
        </Button>
      </div>

      {creating && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-64">
            <Label htmlFor="new-interest-category" className="mb-1 block text-xs text-muted-foreground">
              New expense category
            </Label>
            <Input
              id="new-interest-category"
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void createCategory(); }}
              autoFocus
            />
          </div>
          <Button onClick={() => void createCategory()} disabled={creatingBusy || !newCategoryName.trim()}>
            {creatingBusy ? "Creating…" : "Create and use"}
          </Button>
          <Button variant="ghost" onClick={() => setCreating(false)} disabled={creatingBusy}>
            Cancel
          </Button>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      {assessment.status !== "insufficient" && (
        <div className="rounded-lg border bg-muted/30 p-3 text-sm">
          {assessment.status === "in_line" ? (
            <p>
              Your last {assessment.periods} booked payments match this schedule (booked{" "}
              {formatCurrency(assessment.booked, loan.currency)}, calculated{" "}
              {formatCurrency(assessment.calculated, loan.currency)}).
            </p>
          ) : (
            <div className="space-y-2">
              <p className="font-medium">
                {assessment.status === "inconsistent"
                  ? "Booked interest does not follow this schedule."
                  : `Your lender charged ${assessment.status === "over" ? "more" : "less"} than this schedule calculates.`}
              </p>
              <p className="text-muted-foreground">
                Over your last {assessment.periods} booked payments ({assessment.from} to {assessment.to}): booked{" "}
                <span className="font-mono text-foreground">{formatCurrency(assessment.booked, loan.currency)}</span>, calculated{" "}
                <span className="font-mono text-foreground">{formatCurrency(assessment.calculated, loan.currency)}</span>
                {assessment.status === "inconsistent"
                  ? ". The gap is not steady from one payment to the next, so no single rate explains it."
                  : `, which is ${assessment.ratio.toFixed(2)} times the calculated interest.`}
              </p>
              {assessment.fixedAmount != null && (
                <p className="text-muted-foreground">
                  Each of those payments was charged the same{" "}
                  {formatCurrency(assessment.fixedAmount, loan.currency)}, which looks like a fixed
                  interest amount rather than a rate.
                </p>
              )}
              {assessment.suggestedRate != null && (
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-muted-foreground">
                    A rate of about <span className="font-mono text-foreground">{assessment.suggestedRate}%</span>{" "}
                    would produce what was charged. The loan is set to{" "}
                    <span className="font-mono text-foreground">{loan.annualRate}%</span>.
                  </p>
                  <Button size="sm" variant="outline" onClick={() => setRateToApply(assessment.suggestedRate)}>
                    Use {assessment.suggestedRate}%
                  </Button>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Only the {ASSESSMENT_MAX_PERIODS} most recent booked payments from the last 12 months are
                compared. An extra payment or a change to the loan shifts every later payment, so older
                ones can differ from today&apos;s schedule for good reason.
              </p>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={rateToApply != null}
        onOpenChange={(open) => { if (!open) setRateToApply(null); }}
        title={`Change the rate to ${rateToApply ?? ""}%?`}
        description={`This recalculates the whole schedule from ${loan.annualRate}% to ${rateToApply ?? ""}%. Interest and payments already booked are not changed.`}
        confirmLabel={`Use ${rateToApply ?? ""}%`}
        busy={rateSaving}
        busyLabel="Saving…"
        onConfirm={() => void applyRate()}
      />

      <div className="max-h-96 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Payment date</TableHead>
              <TableHead>Calculated interest</TableHead>
              <TableHead>Booked</TableHead>
              <TableHead className="text-right">Entry</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const got = booked.get(r.date);
              const diff = got ? Math.round((got.amount - r.interest) * 100) / 100 : 0;
              return (
                <TableRow key={r.date}>
                  <TableCell className="font-mono">
                    {r.date}
                    {r.date > today && <span className="ml-2 text-xs text-muted-foreground">upcoming</span>}
                  </TableCell>
                  <TableCell className="font-mono text-rose-600">{formatCurrency(r.interest, loan.currency)}</TableCell>
                  <TableCell>
                    {got ? (
                      <span className="font-mono">
                        {formatCurrency(got.amount, loan.currency)}
                        {Math.abs(diff) >= 0.01 && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {formatCurrency(Math.abs(diff), loan.currency)} {diff > 0 ? "more" : "less"} than calculated
                          </span>
                        )}
                      </span>
                    ) : (
                      <Input
                        type="number"
                        step="0.01"
                        min="0.01"
                        aria-label={`Interest to book for ${r.date}`}
                        className="h-8 w-32"
                        value={edits[r.date] ?? String(r.interest)}
                        onChange={(e) => { setEdits((cur) => ({ ...cur, [r.date]: e.target.value })); setError(""); }}
                      />
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {got ? (
                      <Link
                        href={entriesUrl(got.transactionIds)}
                        className="text-sm text-primary underline-offset-4 hover:underline"
                      >
                        {got.transactionIds.length === 1 ? "View entry" : `View ${got.transactionIds.length} entries`}
                      </Link>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => post([r])} disabled={saving || !loaded}>
                        Generate
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-sm text-muted-foreground">
                  No payments on this schedule yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {unmatched.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {unmatched.length} interest {unmatched.length === 1 ? "entry" : "entries"} on this account{" "}
          {unmatched.length === 1 ? "falls" : "fall"} outside the schedule&apos;s dates and{" "}
          {unmatched.length === 1 ? "is" : "are"} not counted against any payment.
        </p>
      )}
    </div>
  );
}
