// Day indicators, week row and year tiles for the Transactions calendar (the
// month grid is the shared <MonthCalendar>). Presentational only: the screen
// owns the mode / anchor / selected day and the data. Mirrors the web's
// transactions-calendar.tsx week and year views.
import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useTheme } from "../../theme";
import { formatCurrency } from "../../lib/format";
import { addDays } from "../../lib/subscriptions";
import { datePartsOf, isoDay, type PeriodTotals } from "../../lib/month-calendar";

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * A day's compact indicators: green dot = income, red dot = spending, grey dot
 * = only transfers / trades, plus the day's transaction count. Amounts don't
 * fit a phone-width day cell (the web also shows dots on phones).
 */
export function DayIndicators({ date, totals }: { date: string; totals: PeriodTotals | undefined }) {
  const { colors } = useTheme();
  if (!totals) return null;
  return (
    <>
      <View style={styles.dots}>
        {totals.income > 0 && <View testID={`income-dot-${date}`} style={[styles.dot, { backgroundColor: colors.pos }]} />}
        {totals.spending > 0 && (
          <View testID={`spending-dot-${date}`} style={[styles.dot, { backgroundColor: colors.neg }]} />
        )}
        {!(totals.income > 0) && !(totals.spending > 0) && (
          <View style={[styles.dot, { backgroundColor: colors.mutedForeground }]} />
        )}
      </View>
      <Text style={[styles.count, { color: colors.mutedForeground }]}>{totals.count}</Text>
    </>
  );
}

/** Legend for the indicators above. */
export function IndicatorLegend() {
  const { colors } = useTheme();
  return (
    <View style={styles.legend}>
      {[
        { label: "Income", color: colors.pos },
        { label: "Spending", color: colors.neg },
      ].map((l) => (
        <View key={l.label} style={styles.legendItem}>
          <View style={[styles.dot, { backgroundColor: l.color }]} />
          <Text style={[styles.legendText, { color: colors.mutedForeground }]}>{l.label}</Text>
        </View>
      ))}
      <View style={styles.legendItem}>
        <Text style={[styles.count, styles.legendCount, { color: colors.mutedForeground }]}>#</Text>
        <Text style={[styles.legendText, { color: colors.mutedForeground }]}>Transactions</Text>
      </View>
    </View>
  );
}

/** Seven day cells, Sunday → Saturday, starting at `start`. */
export function WeekGrid({
  start,
  today,
  selectedDay,
  byDate,
  onSelectDay,
  dayLabel,
}: {
  /** The week's Sunday (ISO). */
  start: string;
  today: string;
  selectedDay: string | null;
  byDate: Map<string, PeriodTotals>;
  /** The tapped day, or null when the selected day is tapped again. */
  onSelectDay: (day: string | null) => void;
  /** Extra screen-reader text for a day (empty = none). */
  dayLabel: (iso: string) => string;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.weekRow}>
      {Array.from({ length: 7 }, (_, i) => {
        const iso = addDays(start, i);
        const p = datePartsOf(iso);
        const isSelected = selectedDay === iso;
        const isToday = iso === today;
        const extra = dayLabel(iso);
        return (
          <TouchableOpacity
            key={iso}
            testID={`week-day-${iso}`}
            style={[styles.weekCell, isSelected && { backgroundColor: colors.accent, borderRadius: 10 }]}
            onPress={() => onSelectDay(isSelected ? null : iso)}
            accessibilityLabel={`${WEEKDAY_NAMES[i]} ${MONTH_NAMES[p.month]} ${p.day}${extra ? `, ${extra}` : ""}`}
            accessibilityState={{ selected: isSelected }}
          >
            <Text style={[styles.weekday, { color: colors.mutedForeground }]}>{WEEKDAY_NAMES[i]}</Text>
            <View style={[styles.dayBubble, isToday && { backgroundColor: colors.primary }]}>
              <Text style={[styles.dayText, { color: isToday ? colors.primaryForeground : colors.foreground }]}>
                {p.day}
              </Text>
            </View>
            <DayIndicators date={iso} totals={byDate.get(iso)} />
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

/** Twelve month tiles for `year`; tapping one opens that month. */
export function YearGrid({
  year,
  today,
  months,
  currency,
  onOpenMonth,
}: {
  year: number;
  today: string;
  /** `YYYY-MM` → that month's totals (rollupByMonth). */
  months: Map<string, PeriodTotals>;
  currency: string;
  /** The tapped month, as the ISO date of its 1st. */
  onOpenMonth: (firstOfMonth: string) => void;
}) {
  const { colors } = useTheme();
  const money = (n: number) => formatCurrency(n, currency, { decimals: 0 });
  return (
    <View style={styles.yearGrid}>
      {MONTH_NAMES.map((name, m) => {
        const first = isoDay(year, m, 1);
        const key = first.slice(0, 7);
        const t = months.get(key);
        const isThisMonth = today.slice(0, 7) === key;
        return (
          <TouchableOpacity
            key={key}
            testID={`year-month-${key}`}
            onPress={() => onOpenMonth(first)}
            accessibilityLabel={`Open ${name} ${year}${t ? `, ${t.count} transaction${t.count === 1 ? "" : "s"}` : ""}`}
            style={[
              styles.monthTile,
              { borderColor: isThisMonth ? colors.primary : colors.border, backgroundColor: colors.card },
            ]}
          >
            <Text style={[styles.monthName, { color: colors.foreground }]}>{name}</Text>
            {t ? (
              <>
                {t.income > 0 && (
                  <Text style={[styles.monthLine, { color: colors.pos }]} numberOfLines={1} adjustsFontSizeToFit>
                    +{money(t.income)}
                  </Text>
                )}
                {t.spending !== 0 && (
                  <Text style={[styles.monthLine, { color: colors.neg }]} numberOfLines={1} adjustsFontSizeToFit>
                    {t.spending > 0 ? "−" : "+"}
                    {money(Math.abs(t.spending))}
                  </Text>
                )}
                <Text style={[styles.monthLine, { color: colors.mutedForeground }]}>{t.count} tx</Text>
              </>
            ) : (
              <Text style={[styles.monthLine, { color: colors.mutedForeground }]}>No transactions</Text>
            )}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  dots: { flexDirection: "row", marginTop: 3, height: 6 },
  dot: { width: 6, height: 6, borderRadius: 3, marginHorizontal: 1 },
  count: { fontSize: 10, fontWeight: "600", marginTop: 2, fontVariant: ["tabular-nums"] },
  legend: { flexDirection: "row", justifyContent: "center", flexWrap: "wrap", marginTop: 8 },
  legendItem: { flexDirection: "row", alignItems: "center", marginHorizontal: 6 },
  legendText: { fontSize: 11, marginLeft: 4 },
  legendCount: { marginTop: 0 },
  weekRow: { flexDirection: "row" },
  weekCell: { width: "14.2857%", height: 76, alignItems: "center", paddingTop: 4 },
  weekday: { fontSize: 11, fontWeight: "700", marginBottom: 2 },
  dayBubble: { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  dayText: { fontSize: 13, fontWeight: "600" },
  yearGrid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between" },
  monthTile: {
    width: "32%",
    minHeight: 78,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 8,
    marginBottom: 8,
  },
  monthName: { fontSize: 13, fontWeight: "700", marginBottom: 2 },
  monthLine: { fontSize: 11, marginTop: 1, fontVariant: ["tabular-nums"] },
});
