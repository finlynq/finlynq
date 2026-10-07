"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ChevronLeft, ChevronRight } from "lucide-react";

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** `YYYY-MM-DD` for a day of a (year, 0-based month). */
export function isoDay(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Previous / title / Today / next row shared by every calendar period view
 * (MonthCalendar, and the Transactions calendar's week and year views).
 * `onToday` omitted ⇒ no Today button (already showing the current period).
 */
export function CalendarHeader({
  title,
  unit,
  onShift,
  onToday,
  todayLabel = "Today",
}: {
  title: string;
  /** "month" / "week" / "year" — only used in the arrow buttons' labels. */
  unit: string;
  onShift: (delta: number) => void;
  onToday?: () => void;
  todayLabel?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2 mb-3">
      <Button variant="outline" size="icon" onClick={() => onShift(-1)} aria-label={`Previous ${unit}`}>
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        {onToday && (
          <Button variant="ghost" size="sm" onClick={onToday}>{todayLabel}</Button>
        )}
      </div>
      <Button variant="outline" size="icon" onClick={() => onShift(1)} aria-label={`Next ${unit}`}>
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}

/**
 * Month grid shared by the Subscriptions and Transactions calendars: month
 * navigation, weekday header, leading blanks, and one selectable button per
 * day. Callers own the (year, month, selectedDay) state and draw each day's
 * contents through `renderDay`; dates are UTC so a grid never shifts a day
 * across a timezone boundary.
 */
export function MonthCalendar({
  year,
  month,
  today,
  selectedDay,
  onSelectDay,
  onShiftMonth,
  onToday,
  renderDay,
  dayLabel,
}: {
  year: number;
  /** 0-based (January = 0). */
  month: number;
  /** Local `YYYY-MM-DD` used to ring today and decide whether "Today" shows. */
  today: string;
  selectedDay: number | null;
  /** Called with the clicked day, or null when the selected day is clicked again. */
  onSelectDay: (day: number | null) => void;
  onShiftMonth: (delta: number) => void;
  onToday: () => void;
  /** Contents under the day number. */
  renderDay?: (day: number) => ReactNode;
  /** Extra screen-reader text for a day, e.g. "3 payments". */
  dayLabel?: (day: number) => string;
}) {
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const monthLabel = new Date(Date.UTC(year, month, 1)).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    timeZone: "UTC",
  });
  const isCurrentMonth = today.slice(0, 7) === isoDay(year, month, 1).slice(0, 7);
  const todayDay = Number(today.slice(8, 10));

  return (
    <>
      <CalendarHeader
        title={monthLabel}
        unit="month"
        onShift={onShiftMonth}
        onToday={isCurrentMonth ? undefined : onToday}
      />

      <div className="grid grid-cols-7 gap-px mb-1">
        {DAY_NAMES.map((d) => (
          <div key={d} className="text-center text-xs font-medium text-muted-foreground py-1.5">
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: firstWeekday }, (_, i) => (
          <div key={`pad-${i}`} className="min-h-[56px] sm:min-h-[88px]" />
        ))}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const day = i + 1;
          const isSelected = selectedDay === day;
          const isToday = isCurrentMonth && day === todayDay;
          const extra = dayLabel?.(day);
          return (
            <button
              key={day}
              type="button"
              onClick={() => onSelectDay(isSelected ? null : day)}
              aria-label={`${monthLabel} ${day}${extra ? `, ${extra}` : ""}`}
              aria-pressed={isSelected}
              className={`min-h-[56px] sm:min-h-[88px] min-w-0 p-1 sm:p-1.5 rounded-lg text-left align-top transition-colors border flex flex-col ${
                isSelected ? "border-primary bg-primary/5" : "border-border/60 hover:bg-muted/50"
              }`}
            >
              <span
                className={`text-xs sm:text-sm font-medium inline-flex h-6 w-6 items-center justify-center rounded-full ${
                  isToday ? "bg-primary text-primary-foreground" : ""
                }`}
              >
                {day}
              </span>
              {renderDay?.(day)}
            </button>
          );
        })}
      </div>
    </>
  );
}

/** Month summary tile shown under a MonthCalendar (bills / income / net). */
export function MonthStat({ label, value, tone, icon }: { label: string; value: string; tone: string; icon: ReactNode }) {
  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">{icon}{label}</div>
        <p className={`text-xl font-bold mt-1 tabular-nums ${tone}`}>{value}</p>
      </CardContent>
    </Card>
  );
}
