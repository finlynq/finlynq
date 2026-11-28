"use client";

/**
 * The top of the Forecast page: the answer cards (net worth at the end,
 * lowest cash, debt, retirement), the notes strip (blank lines, warnings,
 * left-out lines folded into one line) and the first-visit card shown when
 * most lines have no budget.
 */
import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency } from "@/lib/currency";
import { cn } from "@/lib/utils";
import type { ForecastResult } from "@/lib/forecast/types";
import type { QuickFillPreview } from "@/lib/forecast/quick-fill";
import type { BlankExplanation } from "@/lib/forecast/blank-lines";
import { AlertTriangle, Info, X } from "lucide-react";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthLong = (ym: string) => `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const monthShort = (ym: string) => MONTH_NAMES[Number(ym.slice(5, 7)) - 1];

function listNames(names: string[], max = 3): string {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

function AnswerCard({ label, children, tone }: { label: string; children: React.ReactNode; tone?: "warn" | "bad" }) {
  return (
    <Card className={cn(tone === "bad" && "border-rose-300 dark:border-rose-900/60", tone === "warn" && "border-amber-300 dark:border-amber-900/60")}>
      <CardContent className="py-3 sm:py-4 space-y-0.5">
        <p className="text-xs text-muted-foreground">{label}</p>
        {children}
      </CardContent>
    </Card>
  );
}

const big = "text-lg sm:text-2xl font-semibold tracking-tight leading-tight";
/** Amounts only: the number font is for figures, not words. */
const num = "tabular-nums";
const sub = "text-xs text-muted-foreground";

export function AnswerCards({
  result,
  real,
  compare,
  onTryRetire,
}: {
  result: ForecastResult;
  real: boolean;
  /** The compared scenario's net worth in the same final month, when known. */
  compare: { label: string; endNetWorth: number } | null;
  onTryRetire: () => void;
}) {
  const cur = result.currency;
  const last = result.months.length - 1;
  const at = (arr: number[], i: number) => (real ? arr[i] / result.deflator[i] : arr[i]);
  const money = (v: number) => formatCurrency(v, cur, { decimals: 0 });
  const endNW = at(result.balances.netWorth, last);
  const change = endNW - result.opening.netWorth;
  const cash = result.balances.cash.map((_, i) => at(result.balances.cash, i));
  const minCashIdx = cash.reduce((mi, v, i, a) => (v < a[mi] ? i : mi), 0);
  const cashNeg = result.milestones.find((m) => m.kind === "cash_negative");
  const depleted = result.milestones.find((m) => m.kind === "investments_depleted");
  const debtFree = result.milestones.find((m) => m.kind === "debt_free");
  const r = result.retirement;

  return (
    <section aria-label="Key results" className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <AnswerCard label={`Net worth in ${monthLong(result.months[last])}`}>
        <p className={cn(big, num)}>{money(endNW)}</p>
        <p className={cn(sub, change >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400")}>
          {change >= 0 ? "+" : "−"}{money(Math.abs(change))} from today{real ? ", today's money" : ""}
        </p>
        {compare && <p className={sub}>{compare.label}: {money(compare.endNetWorth)}</p>}
      </AnswerCard>

      <AnswerCard label="Lowest cash" tone={cashNeg ? "bad" : cash[minCashIdx] < 1000 ? "warn" : undefined}>
        <p className={cn(big, num, cashNeg && "text-rose-600 dark:text-rose-400")}>{money(cash[minCashIdx])}</p>
        <p className={sub}>
          {cashNeg ? `Below zero from ${monthLong(cashNeg.month)}` : `in ${monthLong(result.months[minCashIdx])}`}
        </p>
        {depleted && <p className={cn(sub, "text-rose-600 dark:text-rose-400")}>{depleted.label} ({monthLong(depleted.month)})</p>}
      </AnswerCard>

      <AnswerCard label="Debt">
        {result.loans.length === 0 ? (
          <><p className={big}>No loans</p><p className={sub}>nothing to pay off</p></>
        ) : debtFree ? (
          <><p className={big}>Free {monthLong(debtFree.month)}</p>
            <p className={sub}>{money(result.loans.reduce((s, l) => s + l.interestTotal, 0))} interest until then</p></>
        ) : (
          <><p className={cn(big, num)}>{money(at(result.balances.loans, last))}</p>
            <p className={sub}>still owed at the end</p></>
        )}
      </AnswerCard>

      <AnswerCard label="Retirement" tone={r?.runsOutMonth ? "bad" : undefined}>
        {r ? (
          <>
            <p className={cn(big, r.runsOutMonth ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400")}>
              {r.runsOutMonth
                ? `Lasts to ${r.runsOutAge != null ? `age ${r.runsOutAge}` : monthLong(r.runsOutMonth)}`
                : `Past ${r.horizonEndAge != null ? `age ${r.horizonEndAge}` : monthLong(r.horizonEndMonth)}`}
            </p>
            <p className={sub}>Retire {monthLong(r.month)}{r.age != null ? `, at ${r.age}` : ""}</p>
          </>
        ) : (
          <>
            <p className={big}>Not planned</p>
            <button type="button" onClick={onTryRetire} className="text-xs text-primary hover:underline text-left">
              Try &quot;Can I retire at…?&quot;
            </button>
          </>
        )}
      </AnswerCard>
    </section>
  );
}

/** `key` identifies the note for dismissing (GH #469): change it when the note says something new. */
export type ForecastNote = { key: string; tone: "warn" | "info"; text: React.ReactNode };

/** Every note on one strip: the first shown, the rest behind "N more notes". */
export function NotesStrip({
  blank,
  explain,
  canFillFromHistory,
  onFillFromHistory,
  onDismiss,
  hiddenCount,
  onShowHidden,
  notes,
}: {
  /** Income/spending lines with no value at all. */
  blank: Array<{ label: string; type: string }>;
  /** Why they are blank (GH #463): the banner names the real reason and links to the first forecast month. */
  explain: BlankExplanation;
  canFillFromHistory: boolean;
  onFillFromHistory: () => void;
  /** Hide the whole strip until a note appears that was not dismissed (GH #469). */
  onDismiss?: () => void;
  /** When the strip is dismissed: how many notes it hides, and how to show them again. */
  hiddenCount?: number;
  onShowHidden?: () => void;
  notes: ForecastNote[];
}) {
  const [open, setOpen] = useState(false);
  if (hiddenCount && hiddenCount > 0) {
    // Dismissed: no banner, just a quiet way back.
    return (
      <p className="text-xs text-muted-foreground">
        {hiddenCount} forecast {hiddenCount === 1 ? "note is" : "notes are"} hidden.{" "}
        <button type="button" className="underline underline-offset-2" onClick={onShowHidden}>
          Show
        </button>
      </p>
    );
  }
  const hasBlank = blank.length > 0;
  const first: ForecastNote | null = hasBlank ? null : notes[0] ?? null;
  const rest = hasBlank ? notes : notes.slice(1);
  if (!hasBlank && notes.length === 0) return null;
  const warn = notes.some((n) => n.tone === "warn") || hasBlank;
  return (
    <div
      className={cn(
        "rounded-lg border p-3 text-sm space-y-2",
        warn ? "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100" : "text-muted-foreground",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {warn ? <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" /> : <Info className="h-4 w-4 shrink-0" aria-hidden="true" />}
        <span className="flex-[1_1_280px]">
          {hasBlank ? (
            <>
              <span className="font-medium">
                {blank.length} {blank.length === 1 ? "line has" : "lines have"} nothing to forecast from {monthLong(explain.startMonth)} on, so{" "}
                {blank.length === 1 ? "it stays" : "they stay"} blank:
              </span>{" "}
              {listNames(blank.map((b) => b.label))}.
            </>
          ) : (
            first?.text
          )}
        </span>
        {hasBlank && canFillFromHistory && (
          <Button size="sm" variant="outline" className="h-8 border-amber-400/70 bg-transparent dark:border-amber-700" onClick={onFillFromHistory}>
            Fill blanks from my history
          </Button>
        )}
        {hasBlank && (
          <Link href={`/budgets?month=${explain.startMonth}`} className="text-xs underline">
            Budget {monthShort(explain.startMonth)} onward
          </Link>
        )}
        {rest.length > 0 && (
          <button type="button" className="text-xs underline-offset-2 hover:underline" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? "Hide notes" : `${rest.length} more ${rest.length === 1 ? "note" : "notes"}`}
          </button>
        )}
        {onDismiss && (
          <Button
            variant="ghost"
            size="icon"
            className={cn("ml-auto h-7 w-7 shrink-0", warn && "hover:bg-amber-100 dark:hover:bg-amber-900/40")}
            aria-label="Dismiss these notes"
            title="Dismiss: hidden until something new comes up"
            onClick={onDismiss}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
      {hasBlank && (
        <ul className="space-y-1 pl-7 text-xs opacity-90">
          {explain.thisMonthOnly.length > 0 && (
            <li>
              {listNames(explain.thisMonthOnly)} {explain.thisMonthOnly.length === 1 ? "has" : "have"} a budget for{" "}
              {monthLong(explain.currentMonth)} only, and the forecast starts in {monthLong(explain.startMonth)}. On Budgets, use{" "}
              <span className="font-medium">Fill this and later months</span> or a <span className="font-medium">rule</span> on the line.
            </li>
          )}
          {explain.historyLookback != null ? (
            <li>
              Your history layer found no spending for {blank.length === 1 ? "it" : "them"} in the last {explain.historyLookback} complete{" "}
              {explain.historyLookback === 1 ? "month" : "months"}. Look back further in <span className="font-medium">Where amounts come from</span>, or budget{" "}
              {blank.length === 1 ? "it" : "them"} from {monthLong(explain.startMonth)} on.
            </li>
          ) : (
            explain.thisMonthOnly.length < blank.length && (
              <li>Give {blank.length === 1 ? "it" : "them"} a budget from {monthLong(explain.startMonth)} on, or fill blanks from your history.</li>
            )
          )}
        </ul>
      )}
      {open && rest.length > 0 && (
        <ul className="space-y-1.5 pl-6 text-sm">
          {rest.map((n, i) => (
            <li key={i} className="list-disc">{n.text}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Shown when most lines have no budget: how to fill the months ahead. */
export function FirstRunCard({
  startMonth,
  blankCount,
  lineCount,
  preview,
  currency,
  onUseHistory,
  onDismiss,
}: {
  /** First forecast month: the Budgets link opens it (GH #463). */
  startMonth: string;
  blankCount: number;
  lineCount: number;
  preview: QuickFillPreview | null;
  currency: string;
  onUseHistory: () => void;
  onDismiss: () => void;
}) {
  const canFill = !!preview && preview.filled > 0;
  const money = (v: number) => formatCurrency(v, currency, { decimals: 0 });
  return (
    <Card className="border-primary/40">
      <CardContent className="py-4 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-base font-semibold">How should we fill in the months ahead?</h2>
            <p className="text-sm text-muted-foreground">
              Your forecast starts from today&apos;s balances and your loans, but {blankCount} of {lineCount} income and spending lines have no budget from next month on (when the forecast starts), so they are blank.
            </p>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label="Hide this" onClick={onDismiss}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <button
            type="button"
            disabled={!canFill}
            onClick={onUseHistory}
            className="flex flex-col items-start gap-1.5 rounded-lg border-2 border-primary bg-primary/10 p-4 text-left transition-colors hover:bg-primary/15 disabled:cursor-not-allowed disabled:border-border disabled:bg-transparent disabled:opacity-60"
          >
            <span className="flex w-full flex-wrap items-center justify-between gap-2">
              <span className="font-semibold">Use my last 12 months</span>
              {canFill && <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">Recommended</span>}
            </span>
            <span className="text-sm text-muted-foreground">Each blank line gets its average from your transactions. Budgets you have still win.</span>
            <span className="text-xs text-muted-foreground">
              {canFill
                ? `Fills ${preview!.filled} ${preview!.filled === 1 ? "line" : "lines"} · about ${money(preview!.monthlyIncome)} in and ${money(preview!.monthlySpending)} out a month`
                : "There are no past months to use yet."}
            </span>
          </button>
          <Link
            href={`/budgets?month=${startMonth}`}
            className="flex flex-col items-start gap-1.5 rounded-lg border p-4 text-left transition-colors hover:bg-muted/50"
          >
            <span className="font-semibold">Set budgets first</span>
            <span className="text-sm text-muted-foreground">
              Plan each category from {monthLong(startMonth)} on (Fill this and later months, or a rule), then come back. Best if your recent months were unusual.
            </span>
          </Link>
          <button
            type="button"
            onClick={onDismiss}
            className="flex flex-col items-start gap-1.5 rounded-lg border p-4 text-left transition-colors hover:bg-muted/50"
          >
            <span className="font-semibold">Leave blanks as they are</span>
            <span className="text-sm text-muted-foreground">Only budgeted lines count. You can fill them any time from &quot;Where amounts come from&quot;.</span>
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
