"use client";

import { useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/currency";
import { localDateISO } from "@/lib/utils/date";
import { FREQUENCY_LABELS } from "@/lib/subscriptions/schedule";
import {
  buildScheduleEvents,
  type RecurringRow,
  type ScheduleEvent,
} from "@/lib/subscriptions/calendar-events";
import type { Subscription } from "./types";
import { CalendarDays, Plus, TrendingDown, TrendingUp, Scale } from "lucide-react";
import { MonthCalendar, MonthStat, isoDay } from "@/components/month-calendar";

/** Chip / dot styling per event kind. Legend reads the same map. */
function eventTone(ev: Pick<ScheduleEvent, "type" | "source">) {
  if (ev.type === "income") {
    return { dot: "bg-emerald-500", chip: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300", text: "text-emerald-600" };
  }
  if (ev.source === "subscription") {
    return { dot: "bg-primary", chip: "bg-primary/15 text-foreground", text: "text-rose-600" };
  }
  return { dot: "bg-rose-500", chip: "bg-rose-500/10 text-rose-700 dark:text-rose-300", text: "text-rose-600" };
}

/**
 * Calendar view of the Subscriptions page: every active subscription's
 * projected payments plus detected recurring bills/income that aren't tracked
 * yet. Event math lives in lib/subscriptions/calendar-events.ts, shared with
 * the list view's totals.
 */
export function SubscriptionsCalendar({
  subs,
  recurring,
  displayCurrency,
  onEdit,
  onTrack,
}: {
  subs: Subscription[];
  recurring: RecurringRow[];
  displayCurrency: string;
  onEdit: (id: number) => void;
  onTrack: (r: RecurringRow) => void;
}) {
  const today = localDateISO();
  const [year, setYear] = useState(() => Number(today.slice(0, 4)));
  const [month, setMonth] = useState(() => Number(today.slice(5, 7)) - 1);
  const [selectedDay, setSelectedDay] = useState<number | null>(() => Number(today.slice(8, 10)));

  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const monthStart = isoDay(year, month, 1);
  const monthEnd = isoDay(year, month, daysInMonth);

  const events = useMemo(
    () => buildScheduleEvents(subs, recurring, monthStart, monthEnd),
    [subs, recurring, monthStart, monthEnd],
  );

  const eventsByDay = useMemo(() => {
    const map = new Map<number, ScheduleEvent[]>();
    for (const ev of events) {
      const day = Number(ev.date.slice(8, 10));
      map.set(day, [...(map.get(day) ?? []), ev]);
    }
    return map;
  }, [events]);

  // FINLYNQ-123 — month totals sum the display-currency amounts, never the
  // native ones (mixed currencies under one label was feedback #7).
  const totalBills = events.filter((e) => e.type === "bill").reduce((s, e) => s + e.displayAmount, 0);
  const totalIncome = events.filter((e) => e.type === "income").reduce((s, e) => s + e.displayAmount, 0);
  const net = totalIncome - totalBills;

  function shiftMonth(delta: number) {
    const total = year * 12 + month + delta;
    setYear(Math.floor(total / 12));
    setMonth(((total % 12) + 12) % 12);
    setSelectedDay(null);
  }

  function goToday() {
    setYear(Number(today.slice(0, 4)));
    setMonth(Number(today.slice(5, 7)) - 1);
    setSelectedDay(Number(today.slice(8, 10)));
  }

  const selectedEvents = selectedDay ? eventsByDay.get(selectedDay) ?? [] : [];

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-5">
          <MonthCalendar
            year={year}
            month={month}
            today={today}
            selectedDay={selectedDay}
            onSelectDay={setSelectedDay}
            onShiftMonth={shiftMonth}
            onToday={goToday}
            dayLabel={(day) => {
              const n = eventsByDay.get(day)?.length ?? 0;
              return n ? `${n} payment${n === 1 ? "" : "s"}` : "";
            }}
            renderDay={(day) => {
              const dayEvents = eventsByDay.get(day) ?? [];
              return (
                <>
                  {/* Phone width: dots. Wider: named chips. */}
                  {dayEvents.length > 0 && (
                    <div className="flex flex-wrap gap-0.5 mt-1 sm:hidden">
                      {dayEvents.slice(0, 3).map((ev, idx) => (
                        <span key={idx} className={`h-1.5 w-1.5 rounded-full ${eventTone(ev).dot}`} />
                      ))}
                    </div>
                  )}
                  <div className="hidden sm:flex flex-col gap-0.5 mt-1 w-full min-w-0">
                    {dayEvents.slice(0, 2).map((ev, idx) => (
                      <span
                        key={idx}
                        className={`truncate rounded px-1 text-[11px] leading-4 ${eventTone(ev).chip}`}
                        title={`${ev.name} · ${formatCurrency(ev.amount, ev.currency)}`}
                      >
                        {ev.name}
                      </span>
                    ))}
                    {dayEvents.length > 2 && (
                      <span className="text-[10px] text-muted-foreground leading-3 px-1">+{dayEvents.length - 2} more</span>
                    )}
                  </div>
                </>
              );
            }}
          />

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-primary" /> Subscription</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-rose-500" /> Detected bill</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-emerald-500" /> Expected income</span>
          </div>
        </CardContent>
      </Card>

      {selectedDay !== null && (
        <Card>
          <CardContent className="pt-5">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <CalendarDays className="h-4 w-4" />
              {new Date(Date.UTC(year, month, selectedDay)).toLocaleDateString(undefined, {
                weekday: "long",
                month: "long",
                day: "numeric",
                timeZone: "UTC",
              })}
            </h3>
            {selectedEvents.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing expected on this day.</p>
            ) : (
              <div className="divide-y">
                {selectedEvents.map((ev, idx) => {
                  const tone = eventTone(ev);
                  return (
                    <div key={`${ev.name}-${idx}`} className="flex items-center justify-between gap-3 py-2.5">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${tone.dot}`} />
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{ev.name}</p>
                          <div className="flex flex-wrap gap-1.5 mt-0.5">
                            <Badge variant="secondary" className="text-xs">
                              {ev.source === "subscription" ? "Subscription" : ev.type === "income" ? "Expected income" : "Detected"}
                            </Badge>
                            <Badge variant="outline" className="text-xs">{FREQUENCY_LABELS[ev.frequency]}</Badge>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={`font-semibold text-sm tabular-nums ${tone.text}`}>
                          {ev.type === "income" ? "+" : "−"}
                          {formatCurrency(ev.amount, ev.currency)}
                        </span>
                        {ev.source === "subscription" && ev.subscriptionId != null && (
                          <Button variant="outline" size="sm" onClick={() => onEdit(ev.subscriptionId!)}>Edit</Button>
                        )}
                        {ev.source === "detected" && ev.type === "bill" && ev.detected && (
                          <Button variant="outline" size="sm" onClick={() => onTrack(ev.detected!)}>
                            <Plus className="h-3.5 w-3.5 mr-1" /> Track
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <MonthStat label="Expected bills" value={formatCurrency(totalBills, displayCurrency)} tone="text-rose-600" icon={<TrendingDown className="h-4 w-4 text-rose-600" />} />
        <MonthStat label="Expected income" value={formatCurrency(totalIncome, displayCurrency)} tone="text-emerald-600" icon={<TrendingUp className="h-4 w-4 text-emerald-600" />} />
        <MonthStat
          label="Net for the month"
          value={`${net >= 0 ? "+" : ""}${formatCurrency(net, displayCurrency)}`}
          tone={net >= 0 ? "text-emerald-600" : "text-rose-600"}
          icon={<Scale className="h-4 w-4 text-muted-foreground" />}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Income and untracked bills are projected from repeating transactions in your history. Totals are in {displayCurrency} at today&apos;s rates.
      </p>
    </div>
  );
}
