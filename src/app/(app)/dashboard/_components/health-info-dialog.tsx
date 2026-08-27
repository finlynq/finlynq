"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/currency";
import type { HealthData } from "./types";

interface HealthInfoDialogProps {
  data: HealthData;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const COMPONENT_BLURBS: Record<
  string,
  { what: string; formula: string; note?: string }
> = {
  "Savings Rate": {
    what: "Income minus expenses, divided by income, over the last 3 months.",
    formula: "score = (savingsRate × 500), clamped to 0-100",
    note: "20% savings rate maps to a perfect 100. Categories with type 'I' (income) and 'E' (expense) are counted; transfers and true-ups are excluded.",
  },
  "Debt-to-Income": {
    what: "Trailing-12-month debt payments divided by trailing-12-month income.",
    formula: "score = (1 - DTI) × 100, clamped to 0-100",
    note: "Debt payments = sum of negative amounts on liability accounts. Annualizing a 3-month window distorts in months with skewed payment timing, so this uses the full 12 months on both sides.",
  },
  "Emergency Fund": {
    what: "Liquid cash divided by average monthly expenses.",
    formula: "score = (monthsCovered / 6) × 100, clamped to 0-100",
    note: "Liquid assets exclude investment accounts (uses accounts.is_investment) and any asset group outside Banks / Cash Accounts / Cash / Savings / Chequing / Checking. 6 months of expenses = perfect 100.",
  },
  "Net Worth Trend": {
    what: "Change in total net worth over the last 90 days.",
    formula: "score = 50 + (magnitudePct × 5), clamped to 0-100",
    note: "−10% magnitude scores 0; flat scores 50; +10% scores 100. The component is EXCLUDED (not penalized at 50) when your transaction history is shorter than 60 days.",
  },
  "Budget Adherence": {
    what: "Number of current-month budgets where spending is under the cap, out of total budgets.",
    formula: "score = (onTrack / totalBudgets) × 100",
    note: "Excluded entirely when no budgets are set — the remaining components renormalize across what's left.",
  },
  "Age of Money": {
    what: "Average number of days between when a dollar entered as income and when it left as an expense (FIFO matched).",
    formula: "score = (ageInDays / 30) × 100, clamped to 0-100",
    note: "30+ days of cash buffer = perfect 100. Excluded when there's not enough income/expense history to match.",
  },
};

function fmtMoney(amount: number, currency: string): string {
  return formatCurrency(amount, currency, { decimals: 0 });
}

function ComponentBlock({
  name,
  score,
  weight,
  detail,
  excluded,
}: {
  name: string;
  score?: number;
  weight?: number;
  detail: string;
  excluded?: boolean;
}) {
  const blurb = COMPONENT_BLURBS[name];
  const weightPct = weight != null ? Math.round(weight * 100) : null;
  return (
    <div className="rounded-lg border bg-muted/30 p-3 space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold">{name}</h4>
        {excluded ? (
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Excluded
          </span>
        ) : (
          <div className="text-xs tabular-nums text-muted-foreground">
            <span className="font-semibold text-foreground">{score}</span>
            <span className="opacity-50"> / 100</span>
            {weightPct != null ? (
              <span className="ml-2 opacity-70">weight {weightPct}%</span>
            ) : null}
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">Your data: {detail}</p>
      {blurb ? (
        <>
          <p className="text-xs text-muted-foreground">{blurb.what}</p>
          <p className="text-[11px] font-mono text-muted-foreground/80 bg-background/50 rounded px-2 py-1">
            {blurb.formula}
          </p>
          {blurb.note ? (
            <p className="text-[11px] text-muted-foreground/80">{blurb.note}</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export function HealthInfoDialog({ data, open, onOpenChange }: HealthInfoDialogProps) {
  const reporting = data.reportingCurrency ?? "CAD";
  const totals = data.totals;
  const excluded = data.excludedComponents ?? [];

  // After post-FINLYNQ-94, the canonical 6-component order is fixed. Build a
  // unified list so excluded entries render alongside the kept ones in the
  // same order.
  const CANONICAL_ORDER = [
    "Savings Rate",
    "Debt-to-Income",
    "Emergency Fund",
    "Net Worth Trend",
    "Budget Adherence",
    "Age of Money",
  ] as const;

  const byName = new Map<string, { score?: number; weight?: number; detail: string; excluded: boolean }>();
  for (const c of data.components) {
    byName.set(c.name, { score: c.score, weight: c.weight, detail: c.detail, excluded: false });
  }
  for (const e of excluded) {
    byName.set(e.name, { detail: e.detail, excluded: true });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>How is the Financial Health score calculated?</DialogTitle>
          <DialogDescription>
            Six components, each scored 0-100 and weighted to produce your overall score.
            Components without enough data are excluded — the remaining weights renormalize so
            you&apos;re never penalized for a gap.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-3">
          <div className="rounded-lg border bg-muted/30 p-3 space-y-1.5">
            <div className="flex items-baseline justify-between">
              <h4 className="text-sm font-semibold">Overall Score</h4>
              <div className="text-xs tabular-nums">
                <span className="text-base font-bold">{data.score}</span>
                <span className="text-muted-foreground"> / 100 — {data.grade}</span>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Weighted average of the six component scores (sub-scores summed un-rounded, the final
              score is rounded once at the end to avoid off-by-one drift). All money totals below
              are in <span className="font-mono">{reporting}</span>.
            </p>
            {excluded.length > 0 ? (
              <p className="text-[11px] text-muted-foreground/80">
                Renormalized after excluding: {excluded.map((e) => e.name).join(", ")}.
              </p>
            ) : null}
          </div>

          {CANONICAL_ORDER.map((name) => {
            const row = byName.get(name);
            if (!row) return null;
            return (
              <ComponentBlock
                key={name}
                name={name}
                score={row.score}
                weight={row.weight}
                detail={row.detail}
                excluded={row.excluded}
              />
            );
          })}

          {totals ? (
            <div className="rounded-lg border bg-muted/30 p-3 space-y-1.5">
              <h4 className="text-sm font-semibold">Your inputs</h4>
              <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                {totals.totalIncome3m ? (
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Income (3m)</dt>
                    <dd className="tabular-nums">
                      {fmtMoney(totals.totalIncome3m.amount, totals.totalIncome3m.currency)}
                    </dd>
                  </div>
                ) : null}
                {totals.totalExpenses3m ? (
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Expenses (3m)</dt>
                    <dd className="tabular-nums">
                      {fmtMoney(totals.totalExpenses3m.amount, totals.totalExpenses3m.currency)}
                    </dd>
                  </div>
                ) : null}
                {totals.avgMonthlyExpenses3m ? (
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Avg monthly expenses</dt>
                    <dd className="tabular-nums">
                      {fmtMoney(
                        totals.avgMonthlyExpenses3m.amount,
                        totals.avgMonthlyExpenses3m.currency,
                      )}
                    </dd>
                  </div>
                ) : null}
                {totals.totalIncome12m ? (
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Income (12m)</dt>
                    <dd className="tabular-nums">
                      {fmtMoney(totals.totalIncome12m.amount, totals.totalIncome12m.currency)}
                    </dd>
                  </div>
                ) : null}
                {totals.totalDebtPayments12m ? (
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Debt payments (12m)</dt>
                    <dd className="tabular-nums">
                      {fmtMoney(
                        totals.totalDebtPayments12m.amount,
                        totals.totalDebtPayments12m.currency,
                      )}
                    </dd>
                  </div>
                ) : null}
                {totals.totalLiabilities ? (
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Total liabilities</dt>
                    <dd className="tabular-nums">
                      {fmtMoney(
                        totals.totalLiabilities.amount,
                        totals.totalLiabilities.currency,
                      )}
                    </dd>
                  </div>
                ) : null}
                {totals.liquidAssets ? (
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Liquid assets</dt>
                    <dd className="tabular-nums">
                      {fmtMoney(totals.liquidAssets.amount, totals.liquidAssets.currency)}
                    </dd>
                  </div>
                ) : null}
                {totals.netWorthToday ? (
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Net worth (today)</dt>
                    <dd className="tabular-nums">
                      {fmtMoney(totals.netWorthToday.amount, totals.netWorthToday.currency)}
                    </dd>
                  </div>
                ) : null}
                {totals.netWorth90DaysAgo ? (
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Net worth (90d ago)</dt>
                    <dd className="tabular-nums">
                      {fmtMoney(
                        totals.netWorth90DaysAgo.amount,
                        totals.netWorth90DaysAgo.currency,
                      )}
                    </dd>
                  </div>
                ) : null}
                {totals.ageOfMoneyDays != null && totals.ageOfMoneyDays > 0 ? (
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Age of money</dt>
                    <dd className="tabular-nums">
                      {totals.ageOfMoneyDays}d
                      {totals.ageOfMoneyTrendDays != null && totals.ageOfMoneyTrendDays !== 0
                        ? ` (${totals.ageOfMoneyTrendDays > 0 ? "+" : ""}${totals.ageOfMoneyTrendDays}d trend)`
                        : ""}
                    </dd>
                  </div>
                ) : null}
              </dl>
              {/* 2026-08-27 — the net-worth figures above go through the same
                  shared overlay as the dashboard's Total Net Worth tile, so
                  they normally agree exactly. They can only fall back to net
                  contributions when no usable decryption key was available to
                  price holdings; say so rather than let a smaller number look
                  like a disagreement between two screens. */}
              {data.netWorthBasis === "ledger" && data.netWorthNote ? (
                <p className="text-xs text-muted-foreground">{data.netWorthNote}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
