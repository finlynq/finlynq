"use client";

import { DevModeGuard } from "@/components/dev-mode-guard";

import { useEffect, useState, useCallback, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/currency";
import {
  ChevronLeft,
  ChevronRight,
  DollarSign,
  TrendingDown,
  TrendingUp,
  CalendarDays,
} from "lucide-react";

type CalendarEvent = {
  date: string;
  name: string;
  amount: number;
  type: "bill" | "income";
  source: "subscription" | "recurring";
  frequency: string;
};

type Subscription = {
  id: number;
  name: string;
  amount: number;
  currency: string;
  frequency: string;
  nextDate: string | null;
  status: string;
};

type RecurringItem = {
  payee: string;
  avgAmount: number;
  frequency: string;
  nextDate: string;
};

function addFrequency(dateStr: string, frequency: string): string {
  const d = new Date(dateStr + "T00:00:00");
  switch (frequency) {
    case "weekly":
      d.setDate(d.getDate() + 7);
      break;
    case "biweekly":
      d.setDate(d.getDate() + 14);
      break;
    case "monthly":
      d.setMonth(d.getMonth() + 1);
      break;
    case "quarterly":
      d.setMonth(d.getMonth() + 3);
      break;
    case "annual":
      d.setFullYear(d.getFullYear() + 1);
      break;
  }
  return d.toISOString().split("T")[0];
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfWeek(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

function generateOccurrences(
  name: string,
  amount: number,
  frequency: string,
  nextDate: string,
  monthStart: string,
  monthEnd: string,
  type: "bill" | "income",
  source: "subscription" | "recurring"
): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  let current = nextDate;

  // Walk backwards if nextDate is after monthEnd to find earlier occurrences
  // Walk forward from nextDate to cover the month
  // First, rewind to before monthStart
  let rewindDate = current;
  for (let i = 0; i < 60; i++) {
    if (rewindDate <= monthStart) break;
    // Go backwards
    const d = new Date(rewindDate + "T00:00:00");
    switch (frequency) {
      case "weekly":
        d.setDate(d.getDate() - 7);
        break;
      case "biweekly":
        d.setDate(d.getDate() - 14);
        break;
      case "monthly":
        d.setMonth(d.getMonth() - 1);
        break;
      case "quarterly":
        d.setMonth(d.getMonth() - 3);
        break;
      case "annual":
        d.setFullYear(d.getFullYear() - 1);
        break;
    }
    rewindDate = d.toISOString().split("T")[0];
  }

  // Now walk forward through the month
  current = rewindDate;
  for (let i = 0; i < 60; i++) {
    if (current > monthEnd) break;
    if (current >= monthStart && current <= monthEnd) {
      events.push({ date: current, name, amount, type, source, frequency });
    }
    current = addFrequency(current, frequency);
  }

  return events;
}

function CalendarPageContent() {
  const [currentYear, setCurrentYear] = useState(new Date().getFullYear());
  const [currentMonth, setCurrentMonth] = useState(new Date().getMonth());
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [recurring, setRecurring] = useState<RecurringItem[]>([]);
  const [selectedDay, setSelectedDay] = useState<number | null>(null);

  const load = useCallback(() => {
    fetch("/api/subscriptions")
      .then((r) => r.json())
      .then(setSubscriptions);
    fetch("/api/recurring")
      .then((r) => r.json())
      .then((data) => setRecurring(data.recurring ?? []));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function prevMonth() {
    if (currentMonth === 0) {
      setCurrentMonth(11);
      setCurrentYear(currentYear - 1);
    } else {
      setCurrentMonth(currentMonth - 1);
    }
    setSelectedDay(null);
  }

  function nextMonth() {
    if (currentMonth === 11) {
      setCurrentMonth(0);
      setCurrentYear(currentYear + 1);
    } else {
      setCurrentMonth(currentMonth + 1);
    }
    setSelectedDay(null);
  }

  // Generate calendar events for the current month
  const events = useMemo(() => {
    const monthStart = `${currentYear}-${String(currentMonth + 1).padStart(2, "0")}-01`;
    const daysInMonth = getDaysInMonth(currentYear, currentMonth);
    const monthEnd = `${currentYear}-${String(currentMonth + 1).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}`;

    const allEvents: CalendarEvent[] = [];

    // From subscriptions (active only)
    for (const sub of subscriptions.filter((s) => s.status === "active")) {
      if (!sub.nextDate) continue;
      const occurrences = generateOccurrences(
        sub.name,
        sub.amount,
        sub.frequency,
        sub.nextDate,
        monthStart,
        monthEnd,
        "bill",
        "subscription"
      );
      allEvents.push(...occurrences);
    }

    // From recurring transactions
    for (const r of recurring) {
      // Skip if already tracked as subscription
      const alreadyTracked = subscriptions.some(
        (s) =>
          s.name.toLowerCase() === r.payee.toLowerCase() &&
          s.status === "active"
      );
      if (alreadyTracked) continue;

      const type = r.avgAmount > 0 ? "income" : "bill";
      const occurrences = generateOccurrences(
        r.payee,
        Math.abs(r.avgAmount),
        r.frequency,
        r.nextDate,
        monthStart,
        monthEnd,
        type,
        "recurring"
      );
      allEvents.push(...occurrences);
    }

    return allEvents;
  }, [currentYear, currentMonth, subscriptions, recurring]);

  // Group events by day
  const eventsByDay = useMemo(() => {
    const map = new Map<number, CalendarEvent[]>();
    for (const ev of events) {
      const day = parseInt(ev.date.split("-")[2]);
      map.set(day, [...(map.get(day) ?? []), ev]);
    }
    return map;
  }, [events]);

  // Month summary
  const totalIncome = events
    .filter((e) => e.type === "income")
    .reduce((s, e) => s + e.amount, 0);
  const totalBills = events
    .filter((e) => e.type === "bill")
    .reduce((s, e) => s + e.amount, 0);
  const net = totalIncome - totalBills;

  const daysInMonth = getDaysInMonth(currentYear, currentMonth);
  const firstDay = getFirstDayOfWeek(currentYear, currentMonth);
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const monthLabel = new Date(currentYear, currentMonth).toLocaleDateString(
    "en-CA",
    { year: "numeric", month: "long" }
  );

  const today = new Date();
  const isToday = (day: number) =>
    currentYear === today.getFullYear() &&
    currentMonth === today.getMonth() &&
    day === today.getDate();

  const selectedEvents = selectedDay ? eventsByDay.get(selectedDay) ?? [] : [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Bill Calendar</h1>
        <p className="text-sm text-muted-foreground mt-1">
          View expected bills and income throughout the month
        </p>
      </div>

      {/* Month navigation */}
      <div className="flex items-center justify-between">
        <Button variant="outline" size="icon" onClick={prevMonth}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <h2 className="text-xl font-semibold">{monthLabel}</h2>
        <Button variant="outline" size="icon" onClick={nextMonth}>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      {/* Calendar grid */}
      <Card>
        <CardContent className="pt-6">
          {/* Day headers */}
          <div className="grid grid-cols-7 gap-px mb-1">
            {dayNames.map((d) => (
              <div
                key={d}
                className="text-center text-xs font-medium text-muted-foreground py-2"
              >
                {d}
              </div>
            ))}
          </div>

          {/* Calendar cells */}
          <div className="grid grid-cols-7 gap-px">
            {/* Empty cells for padding */}
            {Array.from({ length: firstDay }, (_, i) => (
              <div key={`empty-${i}`} className="min-h-[72px]" />
            ))}

            {/* Day cells */}
            {Array.from({ length: daysInMonth }, (_, i) => {
              const day = i + 1;
              const dayEvents = eventsByDay.get(day) ?? [];
              const hasBill = dayEvents.some((e) => e.type === "bill");
              const hasIncome = dayEvents.some((e) => e.type === "income");
              const isSelected = selectedDay === day;

              return (
                <button
                  key={day}
                  onClick={() =>
                    setSelectedDay(isSelected ? null : day)
                  }
                  className={`min-h-[72px] p-1.5 rounded-lg text-left transition-colors border ${
                    isSelected
                      ? "border-primary bg-primary/5"
                      : "border-transparent hover:bg-muted/50"
                  } ${isToday(day) ? "bg-blue-50" : ""}`}
                >
                  <span
                    className={`text-sm font-medium ${
                      isToday(day) ? "text-blue-600" : ""
                    }`}
                  >
                    {day}
                  </span>
                  <div className="flex flex-wrap gap-0.5 mt-1">
                    {hasIncome && (
                      <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    )}
                    {hasBill && (
                      <span className="h-2 w-2 rounded-full bg-rose-500" />
                    )}
                    {dayEvents.length > 2 && (
                      <span className="text-[10px] text-muted-foreground leading-none">
                        +{dayEvents.length - (hasIncome && hasBill ? 2 : 1)}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Selected day details */}
      {selectedDay !== null && (
        <Card>
          <CardContent className="pt-6">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <CalendarDays className="h-4 w-4" />
              {new Date(
                currentYear,
                currentMonth,
                selectedDay
              ).toLocaleDateString("en-CA", {
                weekday: "long",
                month: "long",
                day: "numeric",
              })}
            </h3>
            {selectedEvents.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No expected transactions on this day.
              </p>
            ) : (
              <div className="space-y-2">
                {selectedEvents.map((ev, idx) => (
                  <div
                    key={`${ev.name}-${idx}`}
                    className="flex items-center justify-between py-2 border-b last:border-0"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`h-2.5 w-2.5 rounded-full ${
                          ev.type === "income"
                            ? "bg-emerald-500"
                            : "bg-rose-500"
                        }`}
                      />
                      <div>
                        <p className="text-sm font-medium">{ev.name}</p>
                        <div className="flex gap-1.5">
                          <Badge
                            variant="outline"
                            className={`text-xs ${
                              ev.type === "income"
                                ? "text-emerald-600"
                                : "text-rose-600"
                            }`}
                          >
                            {ev.type === "income" ? "Income" : "Bill"}
                          </Badge>
                          <Badge variant="secondary" className="text-xs">
                            {ev.source === "subscription"
                              ? "Subscription"
                              : "Recurring"}
                          </Badge>
                        </div>
                      </div>
                    </div>
                    <span
                      className={`font-semibold ${
                        ev.type === "income"
                          ? "text-emerald-600"
                          : "text-rose-600"
                      }`}
                    >
                      {ev.type === "income" ? "+" : "-"}
                      {formatCurrency(ev.amount, "CAD")}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Month summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="flex items-center gap-4 pt-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100">
              <TrendingUp className="h-5 w-5 text-emerald-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Expected Income</p>
              <p className="text-2xl font-bold text-emerald-600">
                {formatCurrency(totalIncome, "CAD")}
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-4 pt-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-rose-100">
              <TrendingDown className="h-5 w-5 text-rose-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Expected Bills</p>
              <p className="text-2xl font-bold text-rose-600">
                {formatCurrency(totalBills, "CAD")}
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-4 pt-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100">
              <DollarSign className="h-5 w-5 text-indigo-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Net for Month</p>
              <p
                className={`text-2xl font-bold ${
                  net >= 0 ? "text-emerald-600" : "text-rose-600"
                }`}
              >
                {net >= 0 ? "+" : ""}
                {formatCurrency(net, "CAD")}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
          Expected Income
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-500" />
          Expected Bill / Subscription
        </div>
      </div>
    </div>
  );
}

export default function CalendarPage() { return <DevModeGuard><CalendarPageContent /></DevModeGuard>; }
