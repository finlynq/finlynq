"use client";

import { useMemo } from "react";
import useSWR, { mutate as globalMutate } from "swr";
import { Card, CardContent } from "@/components/ui/card";
import { MonthCalendar, MonthStat, isoDay } from "@/components/month-calendar";
import { formatCurrency } from "@/lib/currency";
import { localDateISO } from "@/lib/utils/date";
import { jsonFetcher, swrListOptions } from "@/lib/swr";
import type { CalendarDay, CalendarMonth } from "@/lib/transactions/calendar";
import { Scale, TrendingDown, TrendingUp } from "lucide-react";

const CALENDAR_KEY_PREFIX = "/api/transactions/calendar";

type CalendarResponse = {
  success?: boolean;
  data?: CalendarMonth & { month: string; displayCurrency: string };
};

/** Re-fetch every calendar month after a create / edit / delete. */
export function refreshTransactionsCalendar() {
  void globalMutate((key) => typeof key === "string" && key.startsWith(CALENDAR_KEY_PREFIX));
}

/**
 * Calendar view of the Transactions page (in-app feedback 2026-10-07). Shows
 * each day's income, spending and transaction count for one month; clicking a
 * day narrows the transaction list below it to that day (the workspace owns
 * the selection and feeds it into the list's date range). Totals come from
 * GET /api/transactions/calendar, which follows the Reports money rules.
 */
export function TransactionsCalendar({
  year,
  month,
  selectedDay,
  accountId,
  categoryId,
  onSelectDay,
  onShiftMonth,
  onToday,
}: {
  year: number;
  month: number;
  selectedDay: number | null;
  accountId: string;
  categoryId: string;
  onSelectDay: (day: number | null) => void;
  onShiftMonth: (delta: number) => void;
  onToday: () => void;
}) {
  const today = localDateISO();
  const monthKey = isoDay(year, month, 1).slice(0, 7);
  const qs = new URLSearchParams({ month: monthKey });
  if (accountId) qs.set("accountId", accountId);
  if (categoryId) qs.set("categoryId", categoryId);

  const { data, error, isLoading } = useSWR<CalendarResponse>(
    `${CALENDAR_KEY_PREFIX}?${qs}`,
    jsonFetcher,
    swrListOptions,
  );
  const result = data?.data;
  const currency = result?.displayCurrency ?? "USD";

  const byDay = useMemo(() => {
    const map = new Map<number, CalendarDay>();
    for (const d of result?.days ?? []) map.set(Number(d.date.slice(8, 10)), d);
    return map;
  }, [result]);

  const totals = result?.totals ?? { income: 0, spending: 0, count: 0 };
  const net = totals.income - totals.spending;
  const money = (n: number) => formatCurrency(n, currency, { decimals: 0 });

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="pt-5">
          <MonthCalendar
            year={year}
            month={month}
            today={today}
            selectedDay={selectedDay}
            onSelectDay={onSelectDay}
            onShiftMonth={onShiftMonth}
            onToday={onToday}
            dayLabel={(day) => {
              const d = byDay.get(day);
              if (!d) return "";
              const parts = [`${d.count} transaction${d.count === 1 ? "" : "s"}`];
              if (d.income) parts.push(`income ${formatCurrency(d.income, currency)}`);
              if (d.spending) parts.push(`spending ${formatCurrency(d.spending, currency)}`);
              return parts.join(", ");
            }}
            renderDay={(day) => {
              const d = byDay.get(day);
              if (!d) return null;
              return (
                <>
                  {/* Phone width: dots. Wider: the day's totals. */}
                  <div className="flex gap-0.5 mt-1 sm:hidden">
                    {d.income > 0 && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />}
                    {d.spending > 0 && <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />}
                    {!d.income && !d.spending && <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />}
                  </div>
                  <div className="hidden sm:flex flex-col mt-1 w-full min-w-0 text-[11px] leading-4 tabular-nums">
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
                    <span className="truncate text-muted-foreground">
                      {d.count} tx
                    </span>
                  </div>
                </>
              );
            }}
          />
          {error ? (
            <p className="mt-3 text-xs text-destructive">Couldn&apos;t load this month&apos;s totals.</p>
          ) : isLoading ? (
            <p className="mt-3 text-xs text-muted-foreground">Loading…</p>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <MonthStat label="Income" value={formatCurrency(totals.income, currency)} tone="text-emerald-600" icon={<TrendingUp className="h-4 w-4 text-emerald-600" />} />
        <MonthStat label="Spending" value={formatCurrency(totals.spending, currency)} tone="text-rose-600" icon={<TrendingDown className="h-4 w-4 text-rose-600" />} />
        <MonthStat
          label="Net for the month"
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
