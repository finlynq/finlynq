// The Home screen's month calendar. Each day is shaded by how much was spent
// (deeper = more), a green dot marks days with income, and the month's income,
// spending and net sit under the grid. Tapping a day swaps those totals for that
// day's summary, with a way into its transactions.
//
// Same data as the Transactions calendar: GET /api/transactions/calendar, which
// follows the Reports money rules and answers in the display currency. A server
// without that route hides the card rather than putting an error on Home.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { formatCurrency } from "../lib/format";
import { localDateISO } from "../lib/subscriptions";
import { dayTitle, isoDay } from "../lib/month-calendar";
import {
  HEAT_LEVELS,
  heatColor,
  maxDailySpending,
  shiftMonthKey,
  spendingLevel,
  transactionCountLabel,
} from "../lib/home-calendar";
import { MonthCalendar } from "./MonthCalendar";
import type { TransactionsCalendarDay, TransactionsCalendarResponse } from "../../../shared/types";

const NETWORK_ERROR = "Cannot connect to server";

export function HomeCalendarCard({
  fallbackCurrency,
  refreshKey,
  onOpenDay,
  onOpenMonth,
}: {
  /** Used until the calendar has answered with its own display currency. */
  fallbackCurrency: string;
  /** Bumped by the Home screen's pull-to-refresh. */
  refreshKey: number;
  /** Open the Transactions calendar on this day (`YYYY-MM-DD`). */
  onOpenDay: (iso: string) => void;
  /** Open the Transactions calendar on this month (`YYYY-MM`). */
  onOpenMonth: (monthKey: string) => void;
}) {
  const { colors } = useTheme();
  const isFocused = useIsFocused();
  const today = localDateISO();
  const [monthKey, setMonthKey] = useState(() => today.slice(0, 7));
  const [selected, setSelected] = useState<string | null>(null);
  // The last answer is kept while another month loads, but only drawn for its own month.
  const [loaded, setLoaded] = useState<{ month: string; data: TransactionsCalendarResponse } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const req = useRef(0);

  const load = useCallback(async (month: string) => {
    const mine = ++req.current;
    setLoading(true);
    try {
      const res = await endpoints.getTransactionsCalendar(month);
      if (mine !== req.current) return;
      if (res.success && Array.isArray(res.data?.days)) {
        setLoaded({ month, data: res.data });
        setError(null);
        return;
      }
      const message = res.success ? "The calendar could not be read." : res.error;
      if (message === "Not found" || message === "HTTP 404") {
        logger.info("home-calendar", "server has no calendar route; hiding the card");
        setUnsupported(true);
        return;
      }
      logger.warn("home-calendar", "fetch failed", { month, error: message });
      setError(message || "Couldn't load the calendar");
    } catch (e) {
      if (mine !== req.current) return;
      logger.error("home-calendar", "fetch threw", { detail: String(e) });
      setError(NETWORK_ERROR);
    } finally {
      if (mine === req.current) setLoading(false);
    }
  }, []);

  // Refetch on focus (a transaction added elsewhere shows up), on a month
  // change, and on the Home screen's pull-to-refresh.
  useEffect(() => {
    if (isFocused) load(monthKey);
  }, [isFocused, monthKey, refreshKey, load]);

  const view = loaded && loaded.month === monthKey ? loaded.data : null;
  const currency = view?.displayCurrency || loaded?.data.displayCurrency || fallbackCurrency;
  const byDate = useMemo(() => {
    const map = new Map<string, TransactionsCalendarDay>();
    for (const d of view?.days ?? []) map.set(d.date, d);
    return map;
  }, [view]);
  const maxSpending = useMemo(() => maxDailySpending(view?.days ?? []), [view]);

  if (unsupported) return null;

  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7)) - 1;
  const selectedDay = selected && selected.slice(0, 7) === monthKey ? Number(selected.slice(8, 10)) : null;
  const money = (n: number) => formatCurrency(n, currency);
  const whole = (n: number) => formatCurrency(n, currency, { decimals: 0 });

  const shiftMonth = (delta: number) => {
    setMonthKey((m) => shiftMonthKey(m, delta));
    setSelected(null);
  };
  const goToToday = () => {
    setMonthKey(today.slice(0, 7));
    setSelected(null);
  };

  const dayLabel = (day: number) => {
    const d = byDate.get(isoDay(year, month, day));
    if (!d) return "";
    const parts = [transactionCountLabel(d.count)];
    if (d.spending > 0) parts.push(`spent ${money(d.spending)}`);
    if (d.income > 0) parts.push(`received ${money(d.income)}`);
    return parts.join(", ");
  };

  const totals = view?.totals;
  const net = totals ? totals.income - totals.spending : 0;
  const selectedTotals = selected ? byDate.get(selected) : undefined;

  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.labelRow}>
        <View style={styles.labelLeft}>
          <Text style={[styles.cardLabel, { color: colors.mutedForeground }]}>Calendar</Text>
          {loading ? <ActivityIndicator size="small" color={colors.primary} style={styles.spinner} /> : null}
        </View>
        <TouchableOpacity
          onPress={() => onOpenMonth(monthKey)}
          accessibilityRole="button"
          accessibilityLabel="Open this month in Transactions"
          hitSlop={8}
        >
          <Text style={[styles.link, { color: colors.primary }]}>Open ›</Text>
        </TouchableOpacity>
      </View>

      <MonthCalendar
        year={year}
        month={month}
        today={today}
        selectedDay={selectedDay}
        onSelectDay={(day) => setSelected(day == null ? null : isoDay(year, month, day))}
        onShiftMonth={shiftMonth}
        onToday={goToToday}
        cellHeight={46}
        dayLabel={dayLabel}
        dayStyle={(day, isSelected) => {
          const d = byDate.get(isoDay(year, month, day));
          const tint = heatColor(colors.neg, d ? spendingLevel(d.spending, maxSpending) : 0);
          return [
            styles.dayCell,
            { borderColor: isSelected ? colors.primary : colors.card },
            tint ? { backgroundColor: tint } : null,
          ];
        }}
        renderDay={(day) => {
          const d = byDate.get(isoDay(year, month, day));
          return (
            <View
              testID={d && d.income > 0 ? `home-income-dot-${day}` : undefined}
              style={[styles.incomeDot, { backgroundColor: d && d.income > 0 ? colors.pos : "transparent" }]}
            />
          );
        }}
      />

      <View style={styles.legend}>
        <Text style={[styles.legendText, { color: colors.mutedForeground }]}>Less</Text>
        {Array.from({ length: HEAT_LEVELS }, (_, i) => (
          <View
            key={i}
            style={[styles.swatch, { backgroundColor: heatColor(colors.neg, i + 1) ?? colors.secondary }]}
          />
        ))}
        <Text style={[styles.legendText, { color: colors.mutedForeground }]}>More spending</Text>
        <View style={[styles.incomeDot, styles.legendDot, { backgroundColor: colors.pos }]} />
        <Text style={[styles.legendText, { color: colors.mutedForeground }]}>Income</Text>
      </View>

      <View style={[styles.divider, { backgroundColor: colors.border }]} />

      {error && !view ? (
        <View style={styles.errorRow}>
          <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text>
          <TouchableOpacity
            onPress={() => load(monthKey)}
            accessibilityRole="button"
            style={[styles.retryBtn, { borderColor: colors.border }]}
          >
            <Text style={[styles.link, { color: colors.primary }]}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : selected && selectedDay != null ? (
        <View>
          <View style={styles.dayHead}>
            <Text style={[styles.dayTitle, { color: colors.foreground }]}>{dayTitle(year, month, selectedDay)}</Text>
            {selectedTotals ? (
              <Text style={[styles.dayCount, { color: colors.mutedForeground }]}>
                {transactionCountLabel(selectedTotals.count)}
              </Text>
            ) : null}
          </View>
          {selectedTotals ? (
            <>
              <View style={styles.stats}>
                <Stat label="Spent" value={money(selectedTotals.spending)} color={colors.neg} />
                <Stat label="Received" value={money(selectedTotals.income)} color={colors.pos} />
              </View>
              <TouchableOpacity
                onPress={() => onOpenDay(selected)}
                accessibilityRole="button"
                style={[styles.openBtn, { backgroundColor: colors.secondary }]}
              >
                <Text style={[styles.openText, { color: colors.primary }]}>See this day&apos;s transactions ›</Text>
              </TouchableOpacity>
            </>
          ) : (
            <Text style={[styles.emptyDay, { color: colors.mutedForeground }]}>No transactions on this day.</Text>
          )}
        </View>
      ) : (
        <View style={styles.stats}>
          <Stat label="Income" value={totals ? whole(totals.income) : "—"} color={colors.pos} />
          <Stat label="Spending" value={totals ? whole(totals.spending) : "—"} color={colors.neg} />
          <Stat
            label="Net"
            value={totals ? `${net > 0 ? "+" : ""}${whole(net)}` : "—"}
            color={!totals ? colors.foreground : net >= 0 ? colors.pos : colors.neg}
          />
        </View>
      )}
    </View>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.stat}>
      <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={[styles.statValue, { color }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 16, paddingTop: 14, marginBottom: 12 },
  labelRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  labelLeft: { flexDirection: "row", alignItems: "center" },
  cardLabel: { fontSize: 13, fontWeight: "600" },
  spinner: { marginLeft: 8, transform: [{ scale: 0.7 }] },
  link: { fontSize: 12, fontWeight: "600" },
  // A card-coloured border is the gutter between shaded days (and the ring of
  // the selected one), so neighbouring shades read as separate tiles.
  dayCell: { borderRadius: 12, borderWidth: 2 },
  incomeDot: { width: 5, height: 5, borderRadius: 2.5, marginTop: 3 },
  legend: { flexDirection: "row", alignItems: "center", justifyContent: "center", flexWrap: "wrap", marginTop: 8 },
  legendText: { fontSize: 11, marginHorizontal: 4 },
  swatch: { width: 12, height: 12, borderRadius: 3, marginHorizontal: 1.5 },
  legendDot: { marginTop: 0, marginLeft: 10 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 12 },
  stats: { flexDirection: "row", gap: 12 },
  stat: { flex: 1 },
  statLabel: { fontSize: 12, marginBottom: 2 },
  statValue: { fontSize: 17, fontWeight: "700", fontVariant: ["tabular-nums"] },
  dayHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 },
  dayTitle: { fontSize: 15, fontWeight: "700", flexShrink: 1, marginRight: 8 },
  dayCount: { fontSize: 12 },
  emptyDay: { fontSize: 13, paddingVertical: 4 },
  openBtn: { marginTop: 12, borderRadius: 10, paddingVertical: 10, alignItems: "center" },
  openText: { fontSize: 14, fontWeight: "700" },
  errorRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  errorText: { flex: 1, fontSize: 13, lineHeight: 18 },
  retryBtn: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
});
