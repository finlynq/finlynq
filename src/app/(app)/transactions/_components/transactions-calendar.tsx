"use client";

import { useMemo, type ReactNode } from "react";
import useSWR, { mutate as globalMutate } from "swr";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CalendarHeader, DAY_NAMES, MonthCalendar, MonthStat, isoDay } from "@/components/month-calendar";
import { formatCurrency } from "@/lib/currency";
import { localDateISO } from "@/lib/utils/date";
import { jsonFetcher, swrListOptions } from "@/lib/swr";
import {
  addDays,
  periodRange,
  rollupByMonth,
  type CalendarDay,
  type CalendarMode,
  type CalendarMonth,
} from "@/lib/transactions/calendar";
import { Scale, TrendingDown, TrendingUp } from "lucide-react";

const CALENDAR_KEY_PREFIX = "/api/transactions/calendar";

type CalendarResponse = {
  success?: boolean;
  data?: CalendarMonth & { start: string; end: string; displayCurrency: string };
};

/** Re-fetch every calendar period after a create / edit / delete. */
export function refreshTransactionsCalendar() {
  void globalMutate((key) => typeof key === "string" && key.startsWith(CALENDAR_KEY_PREFIX));
}

const utcDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) =>
  utcDate(iso).toLocaleDateString(undefined, { ...opts, timeZone: "UTC" });

/** Heading for the visible period. */
export function periodTitle(mode: CalendarMode, anchor: string): string {
  if (mode === "year") return anchor.slice(0, 4);
  if (mode === "month") return fmt(anchor, { month: "long", year: "numeric" });
  const { start, end } = periodRange("week", anchor);
  return `${fmt(start, { month: "short", day: "numeric" })} – ${fmt(end, { month: "short", day: "numeric", year: "numeric" })}`;
}

/** The line above the transaction list: what the list is currently showing. */
export function describeCalendarSelection(mode: CalendarMode, anchor: string, selectedDay: string | null): string {
  if (selectedDay) return `Transactions on ${fmt(selectedDay, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}`;
  if (mode === "week") return `All transactions in the week of ${periodTitle("week", anchor)}`;
  return `All transactions in ${periodTitle(mode, anchor)}`;
}

/**
 * Calendar view of the Transactions page (in-app feedback 2026-10-07: "day /
 * week / month / year … click a date to list that day's transactions").
 *   - week:  seven day cells,
 *   - month: the shared MonthCalendar grid,
 *   - year:  twelve month tiles; clicking one opens that month.
 * Each day shows income, spending and transaction count; clicking a day
 * narrows the list below to it (the workspace owns the selection and feeds it
 * into the list's date range). Data from GET /api/transactions/calendar, which
 * follows the Reports money rules.
 */
export function TransactionsCalendar({
  mode,
  anchor,
  selectedDay,
  accountId,
  categoryId,
  onModeChange,
  onSelectDay,
  onShift,
  onToday,
  onOpenMonth,
}: {
  mode: CalendarMode;
  /** Any ISO date inside the visible period. */
  anchor: string;
  selectedDay: string | null;
  accountId: string;
  categoryId: string;
  onModeChange: (mode: CalendarMode) => void;
  onSelectDay: (day: string | null) => void;
  onShift: (delta: number) => void;
  onToday: () => void;
  /** Year view: a month tile was clicked (ISO date of its 1st). */
  onOpenMonth: (firstOfMonth: string) => void;
}) {
  const today = localDateISO();
  const { start, end } = periodRange(mode, anchor);
  const qs = new URLSearchParams(mode === "month" ? { month: anchor.slice(0, 7) } : { start, end });
  if (accountId) qs.set("accountId", accountId);
  if (categoryId) qs.set("categoryId", categoryId);

  const { data, error, isLoading } = useSWR<CalendarResponse>(
    `${CALENDAR_KEY_PREFIX}?${qs}`,
    jsonFetcher,
    swrListOptions,
  );
  const result = data?.data;
  const currency = result?.displayCurrency ?? "USD";

  const byDate = useMemo(() => {
    const map = new Map<string, CalendarDay>();
    for (const d of result?.days ?? []) map.set(d.date, d);
    return map;
  }, [result]);

  const totals = result?.totals ?? { income: 0, spending: 0, count: 0 };
  const net = totals.income - totals.spending;
  const money = (n: number) => formatCurrency(n, currency, { decimals: 0 });
  const isCurrentPeriod = today >= start && today <= end;

  const dayLabel = (iso: string) => {
    const d = byDate.get(iso);
    if (!d) return "";
    const parts = [`${d.count} transaction${d.count === 1 ? "" : "s"}`];
    if (d.income) parts.push(`income ${formatCurrency(d.income, currency)}`);
    if (d.spending) parts.push(`spending ${formatCurrency(d.spending, currency)}`);
    return parts.join(", ");
  };

  /** Income / spending / count lines for one day (or month, in the year view). */
  const amounts = (d: { income: number; spending: number; count: number } | undefined, dotsOnPhone: boolean): ReactNode => {
    if (!d) return null;
    return (
      <>
        {dotsOnPhone && (
          <div className="flex gap-0.5 mt-1 sm:hidden">
            {d.income > 0 && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />}
            {d.spending > 0 && <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />}
            {!d.income && !d.spending && <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />}
          </div>
        )}
        <div className={`${dotsOnPhone ? "hidden sm:flex" : "flex"} flex-col mt-1 w-full min-w-0 text-[11px] leading-4 tabular-nums`}>
          {d.income > 0 && (
            <span className="truncate text-emerald-600 dark:text-emerald-400" title={formatCurrency(d.income, currency)}>
              +{money(d.income)}
            </span>
          )}
          {d.spending !== 0 && (
            <span className="truncate text-rose-600 dark:text-rose-400" title={formatCurrency(d.spending, currency)}>
              {d.spending > 0 ? "−" : "+"}{money(Math.abs(d.spending))}
            </span>
          )}
          <span className="truncate text-muted-foreground">{d.count} tx</span>
        </div>
      </>
    );
  };

  const anchorYear = Number(anchor.slice(0, 4));
  const anchorMonth = Number(anchor.slice(5, 7)) - 1;

  let body: ReactNode;
  if (mode === "month") {
    const selectedInMonth = selectedDay && selectedDay.slice(0, 7) === anchor.slice(0, 7) ? Number(selectedDay.slice(8, 10)) : null;
    body = (
      <MonthCalendar
        year={anchorYear}
        month={anchorMonth}
        today={today}
        selectedDay={selectedInMonth}
        onSelectDay={(day) => onSelectDay(day == null ? null : isoDay(anchorYear, anchorMonth, day))}
        onShiftMonth={onShift}
        onToday={onToday}
        dayLabel={(day) => dayLabel(isoDay(anchorYear, anchorMonth, day))}
        renderDay={(day) => amounts(byDate.get(isoDay(anchorYear, anchorMonth, day)), true)}
      />
    );
  } else if (mode === "week") {
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    body = (
      <>
        <CalendarHeader title={periodTitle("week", anchor)} unit="week" onShift={onShift} onToday={isCurrentPeriod ? undefined : onToday} />
        <div className="grid grid-cols-7 gap-1">
          {days.map((iso, i) => {
            const isSelected = selectedDay === iso;
            const extra = dayLabel(iso);
            return (
              <button
                key={iso}
                type="button"
                onClick={() => onSelectDay(isSelected ? null : iso)}
                aria-label={`${fmt(iso, { weekday: "long", month: "long", day: "numeric" })}${extra ? `, ${extra}` : ""}`}
                aria-pressed={isSelected}
                className={`min-h-[96px] sm:min-h-[120px] min-w-0 p-1 sm:p-2 rounded-lg text-left border flex flex-col transition-colors ${
                  isSelected ? "border-primary bg-primary/5" : "border-border/60 hover:bg-muted/50"
                }`}
              >
                <span className="text-[11px] text-muted-foreground">{DAY_NAMES[i]}</span>
                <span
                  className={`text-xs sm:text-sm font-medium inline-flex h-6 w-6 items-center justify-center rounded-full ${
                    iso === today ? "bg-primary text-primary-foreground" : ""
                  }`}
                >
                  {Number(iso.slice(8, 10))}
                </span>
                {amounts(byDate.get(iso), false)}
              </button>
            );
          })}
        </div>
      </>
    );
  } else {
    const months = rollupByMonth(result?.days ?? []);
    body = (
      <>
        <CalendarHeader
          title={periodTitle("year", anchor)}
          unit="year"
          onShift={onShift}
          onToday={isCurrentPeriod ? undefined : onToday}
          todayLabel="This year"
        />
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          {Array.from({ length: 12 }, (_, m) => {
            const first = isoDay(anchorYear, m, 1);
            const totalsForMonth = months.get(first.slice(0, 7));
            const isThisMonth = today.slice(0, 7) === first.slice(0, 7);
            return (
              <button
                key={first}
                type="button"
                onClick={() => onOpenMonth(first)}
                aria-label={`Open ${fmt(first, { month: "long", year: "numeric" })}${
                  totalsForMonth ? `, ${totalsForMonth.count} transaction${totalsForMonth.count === 1 ? "" : "s"}` : ""
                }`}
                className={`min-h-[84px] p-2 rounded-lg text-left border flex flex-col transition-colors hover:bg-muted/50 ${
                  isThisMonth ? "border-primary/60" : "border-border/60"
                }`}
              >
                <span className="text-sm font-medium">{fmt(first, { month: "long" })}</span>
                {totalsForMonth ? amounts(totalsForMonth, false) : <span className="mt-1 text-[11px] text-muted-foreground">No transactions</span>}
              </button>
            );
          })}
        </div>
      </>
    );
  }

  const periodWord = mode === "week" ? "week" : mode === "year" ? "year" : "month";

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="pt-5">
          <Tabs value={mode} onValueChange={(v) => onModeChange((v as CalendarMode) ?? "month")} className="mb-3">
            <TabsList>
              <TabsTrigger value="week" className="px-3">Week</TabsTrigger>
              <TabsTrigger value="month" className="px-3">Month</TabsTrigger>
              <TabsTrigger value="year" className="px-3">Year</TabsTrigger>
            </TabsList>
          </Tabs>
          {body}
          {error ? (
            <p className="mt-3 text-xs text-destructive">Couldn&apos;t load these totals.</p>
          ) : isLoading ? (
            <p className="mt-3 text-xs text-muted-foreground">Loading…</p>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <MonthStat label="Income" value={formatCurrency(totals.income, currency)} tone="text-emerald-600" icon={<TrendingUp className="h-4 w-4 text-emerald-600" />} />
        <MonthStat label="Spending" value={formatCurrency(totals.spending, currency)} tone="text-rose-600" icon={<TrendingDown className="h-4 w-4 text-rose-600" />} />
        <MonthStat
          label={`Net for the ${periodWord}`}
          value={`${net >= 0 ? "+" : ""}${formatCurrency(net, currency)}`}
          tone={net >= 0 ? "text-emerald-600" : "text-rose-600"}
          icon={<Scale className="h-4 w-4 text-muted-foreground" />}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Income and spending follow Reports: transfers between your accounts and investment trades are counted as transactions but not as income or spending. Totals are in {currency} and respect the account and category filters.
      </p>
    </div>
  );
}
