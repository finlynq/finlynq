// Month grid shared by the Subscriptions and Transactions calendars (mirrors the
// web src/components/month-calendar.tsx): month navigation with a "Back to
// today" shortcut, a Sunday-first weekday header, leading blanks, and one
// selectable cell per day. Callers own the (year, month, selectedDay) state and
// draw each day's contents under the day number through `renderDay`. Date math
// is UTC (lib/month-calendar.ts) so the grid never shifts a day.
//
// Renders bare (no card) so each screen keeps its own card and legend.
import React, { type ReactNode } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useTheme } from "../theme";
import { Icon } from "./icon";
import { daysInMonth, firstWeekday, monthKeyOf, monthTitle } from "../lib/month-calendar";

const DAY_NAMES = ["S", "M", "T", "W", "T", "F", "S"];

/**
 * Period navigation row: previous / title (+ "Back to today" when `onToday` is
 * given) / next. Shared by the month grid and the week / year views, so every
 * calendar header looks and reads the same.
 */
export function CalendarHeader({
  title,
  unit,
  onShift,
  onToday,
}: {
  title: string;
  /** "month" / "week" / "year" — used in the arrows' accessibility labels. */
  unit: string;
  onShift: (delta: number) => void;
  /** Omit when the period on screen already contains today. */
  onToday?: () => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.head}>
      <TouchableOpacity onPress={() => onShift(-1)} hitSlop={10} accessibilityLabel={`Previous ${unit}`}>
        <Icon name="back" size={20} color={colors.foreground} />
      </TouchableOpacity>
      <TouchableOpacity disabled={!onToday} onPress={onToday}>
        <Text style={[styles.title, { color: colors.foreground }]}>{title}</Text>
        {onToday && <Text style={[styles.todayLink, { color: colors.primary }]}>Back to today</Text>}
      </TouchableOpacity>
      <TouchableOpacity onPress={() => onShift(1)} hitSlop={10} accessibilityLabel={`Next ${unit}`}>
        <Icon name="chevronRight" size={20} color={colors.foreground} />
      </TouchableOpacity>
    </View>
  );
}

export interface MonthCalendarProps {
  year: number;
  /** 0-based (January = 0). */
  month: number;
  /** Local `YYYY-MM-DD`: rings today, and hides "Back to today" on the current month. */
  today: string;
  selectedDay: number | null;
  /** Called with the tapped day, or null when the selected day is tapped again. */
  onSelectDay: (day: number | null) => void;
  onShiftMonth: (delta: number) => void;
  onToday: () => void;
  /** Contents under the day number. */
  renderDay?: (day: number) => ReactNode;
  /** Extra screen-reader text for a day, e.g. "3 payments" (empty = none). */
  dayLabel?: (day: number) => string;
  /** Cell height in points (default 50); taller when a day shows more than dots. */
  cellHeight?: number;
}

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
  cellHeight = 50,
}: MonthCalendarProps) {
  const { colors } = useTheme();
  const dayCount = daysInMonth(year, month);
  const leading = firstWeekday(year, month);
  const label = monthTitle(year, month);
  const isCurrentMonth = today.slice(0, 7) === monthKeyOf(year, month);
  const todayDay = Number(today.slice(8, 10));
  const cellStyle = [styles.cell, { height: cellHeight }];

  return (
    <>
      <CalendarHeader
        title={label}
        unit="month"
        onShift={onShiftMonth}
        onToday={isCurrentMonth ? undefined : onToday}
      />
      <View style={styles.weekRow}>
        {DAY_NAMES.map((d, i) => (
          <Text key={i} style={[styles.weekday, { color: colors.mutedForeground }]}>{d}</Text>
        ))}
      </View>
      <View style={styles.grid}>
        {Array.from({ length: leading }, (_, i) => (
          <View key={`pad-${i}`} style={cellStyle} />
        ))}
        {Array.from({ length: dayCount }, (_, i) => {
          const day = i + 1;
          const isToday = isCurrentMonth && day === todayDay;
          const isSelected = selectedDay === day;
          const extra = dayLabel?.(day);
          return (
            <TouchableOpacity
              key={day}
              testID={`calendar-day-${day}`}
              style={[cellStyle, isSelected && { backgroundColor: colors.accent, borderRadius: 10 }]}
              onPress={() => onSelectDay(isSelected ? null : day)}
              accessibilityLabel={`${label} ${day}${extra ? `, ${extra}` : ""}`}
              accessibilityState={{ selected: isSelected }}
            >
              <View style={[styles.dayBubble, isToday && { backgroundColor: colors.primary }]}>
                <Text style={[styles.dayText, { color: isToday ? colors.primaryForeground : colors.foreground }]}>{day}</Text>
              </View>
              {renderDay?.(day)}
            </TouchableOpacity>
          );
        })}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 4, marginBottom: 8 },
  title: { fontSize: 15, fontWeight: "700", textAlign: "center" },
  todayLink: { fontSize: 11, fontWeight: "600", textAlign: "center", marginTop: 1 },
  weekRow: { flexDirection: "row" },
  weekday: { width: "14.2857%", textAlign: "center", fontSize: 11, fontWeight: "700", paddingBottom: 4 },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: { width: "14.2857%", alignItems: "center", paddingTop: 3 },
  dayBubble: { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  dayText: { fontSize: 13, fontWeight: "600" },
});
