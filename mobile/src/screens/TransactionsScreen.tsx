// Transactions tab — the newest 50 rows as a searchable List, or a month
// Calendar (in-app feedback 2026-10-07, mirrors the web Transactions page's
// calendar view). The calendar's per-day income / spending / count come from
// GET /api/transactions/calendar, which follows the Reports money rules;
// tapping a day lists that day's transactions from the same /api/transactions
// path the list uses.
import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import {
  View,
  Text,
  FlatList,
  ScrollView,
  TextInput,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { formatCurrency, safeName, formatShortDate } from "../lib/format";
import { localDateISO } from "../lib/subscriptions";
import { DEFAULT_DISPLAY_CURRENCY } from "../lib/dashboard";
import { datePartsOf, dayTitle, isoDay, monthKeyOf, shiftYearMonth } from "../lib/month-calendar";
import { MonthCalendar } from "../components/MonthCalendar";
import { StatTile } from "../components/StatTile";
import type {
  Transaction,
  TransactionsCalendarDay,
  TransactionsCalendarResponse,
} from "../../../shared/types";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { TransactionsStackParamList } from "../navigation/TransactionsStack";
import { useIsFocused } from "@react-navigation/native";

type Props = NativeStackScreenProps<TransactionsStackParamList, "TransactionsList">;
type View_ = "list" | "calendar";

/** Rows fetched for one calendar day — far more than a real day holds. */
const DAY_LIMIT = 200;

/** `/api/transactions` query for a single day (the list's sort, one-day range). */
function dayQuery(iso: string): string {
  const params = new URLSearchParams();
  params.set("startDate", iso);
  params.set("endDate", iso);
  params.set("limit", String(DAY_LIMIT));
  params.set("sort", "date");
  params.set("sortDir", "desc");
  return params.toString();
}

/** A server older than the 2026-10 web release has no calendar route. */
function calendarError(error: string): string {
  return error === "Not found" || error === "HTTP 404"
    ? "The calendar needs a newer Finlynq server. Update your server, or use the List view."
    : error;
}

export default function TransactionsScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const isFocused = useIsFocused();
  const [view, setView] = useState<View_>("list");

  // ── list view ────────────────────────────────────────────────────────────
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const fetchTransactions = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      try {
        // Mirror AccountDetailScreen's recognized sort params (the backend reads
        // `sort`/`sortDir`, not `order`). No accountId → all of the user's rows.
        const params = new URLSearchParams();
        params.set("limit", "50");
        params.set("sort", "date");
        params.set("sortDir", "desc");
        if (search.trim()) params.set("search", search.trim());
        const res = await endpoints.getTransactions(params.toString());
        if (res.success) {
          setTransactions(res.data);
          setError(null);
          // Count in the message string (the Diagnostics panel truncates the
          // data object) so an empty result is unambiguous on device.
          logger.info("transactions", `loaded ${res.data.length} rows`);
        } else {
          logger.warn("transactions", "fetch failed", { error: res.error });
          setError(res.error);
        }
      } catch (e) {
        const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        logger.error("transactions", "fetch threw", { detail });
        setError("Cannot connect to server");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [search]
  );

  useEffect(() => {
    if (isFocused && view === "list") fetchTransactions();
  }, [isFocused, view, fetchTransactions]);

  // ── calendar view ────────────────────────────────────────────────────────
  const today = localDateISO();
  // (year, 0-based month, selected day). No day selected → month totals.
  const [cal, setCal] = useState(() => {
    const t = datePartsOf(localDateISO());
    return { year: t.year, month: t.month, day: null as number | null };
  });
  const monthKey = monthKeyOf(cal.year, cal.month);
  const selectedIso = cal.day != null ? isoDay(cal.year, cal.month, cal.day) : null;

  // The last calendar payload is kept across refetches (the grid never blanks);
  // it is only DRAWN while it belongs to the month on screen.
  const [calData, setCalData] = useState<TransactionsCalendarResponse | null>(null);
  const [calLoading, setCalLoading] = useState(false);
  const [calRefreshing, setCalRefreshing] = useState(false);
  const [calError, setCalError] = useState<string | null>(null);
  const calReq = useRef(0);

  // The selected day's rows, tagged with the day they belong to.
  const [dayRows, setDayRows] = useState<{ date: string; rows: Transaction[] } | null>(null);
  const [dayError, setDayError] = useState<{ date: string; message: string } | null>(null);
  const dayReq = useRef(0);

  const fetchCalendar = useCallback(async (month: string, isRefresh = false) => {
    const req = ++calReq.current;
    if (isRefresh) setCalRefreshing(true);
    else setCalLoading(true);
    try {
      const res = await endpoints.getTransactionsCalendar(month);
      if (req !== calReq.current) return; // a newer month was requested
      if (res.success && res.data) {
        setCalData(res.data);
        setCalError(null);
        logger.info("transactions", `calendar ${month}: ${res.data.days?.length ?? 0} days`);
      } else {
        const err = res.success ? "Unexpected response" : res.error;
        logger.warn("transactions", "calendar fetch failed", { month, error: err });
        setCalError(calendarError(err));
      }
    } catch (e) {
      if (req !== calReq.current) return;
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error("transactions", "calendar fetch threw", { detail });
      setCalError("Cannot connect to server");
    } finally {
      if (req === calReq.current) {
        setCalLoading(false);
        setCalRefreshing(false);
      }
    }
  }, []);

  const fetchDay = useCallback(async (iso: string) => {
    const req = ++dayReq.current;
    setDayError(null);
    try {
      const res = await endpoints.getTransactions(dayQuery(iso));
      if (req !== dayReq.current) return; // another day was tapped
      if (res.success) {
        setDayRows({ date: iso, rows: res.data });
      } else {
        logger.warn("transactions", "day fetch failed", { date: iso, error: res.error });
        setDayError({ date: iso, message: res.error });
      }
    } catch (e) {
      if (req !== dayReq.current) return;
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error("transactions", "day fetch threw", { detail });
      setDayError({ date: iso, message: "Cannot connect to server" });
    }
  }, []);

  // Refetch on focus too, so an edit/delete made on TransactionDetail shows up.
  useEffect(() => {
    if (isFocused && view === "calendar") fetchCalendar(monthKey);
  }, [isFocused, view, monthKey, fetchCalendar]);

  useEffect(() => {
    if (isFocused && view === "calendar" && selectedIso) fetchDay(selectedIso);
  }, [isFocused, view, selectedIso, fetchDay]);

  const refreshCalendar = () => {
    fetchCalendar(monthKey, true);
    if (selectedIso) fetchDay(selectedIso);
  };

  const monthData = calData && calData.month === monthKey ? calData : null;
  const byDay = useMemo(() => {
    const map = new Map<number, TransactionsCalendarDay>();
    for (const d of monthData?.days ?? []) map.set(Number(d.date.slice(8, 10)), d);
    return map;
  }, [monthData]);
  const currency = monthData?.displayCurrency ?? calData?.displayCurrency ?? DEFAULT_DISPLAY_CURRENCY;
  const totals = monthData?.totals ?? { income: 0, spending: 0, count: 0 };
  const net = totals.income - totals.spending;
  // Tiles read "—" until the month on screen has loaded, never a fake $0.
  const money = (n: number) => (monthData ? formatCurrency(n, currency) : "—");
  const dayList = dayRows && dayRows.date === selectedIso ? dayRows.rows : null;
  const dayErrorMessage = dayError && dayError.date === selectedIso ? dayError.message : null;
  const selectedSummary = cal.day != null ? byDay.get(cal.day) : undefined;

  const shiftMonth = (delta: number) => {
    const next = shiftYearMonth(cal.year, cal.month, delta);
    setCal({ year: next.year, month: next.month, day: null });
  };
  const goToToday = () => {
    const t = datePartsOf(localDateISO());
    setCal({ year: t.year, month: t.month, day: t.day });
  };

  // ── shared row + actions ─────────────────────────────────────────────────
  const handleDelete = (tx: Transaction) => {
    Alert.alert(
      "Delete Transaction",
      `Delete "${safeName(tx.payee || tx.note, "this transaction")}"?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              const res = await endpoints.deleteTransaction(tx.id);
              if (res.success) {
                setTransactions((prev) => prev.filter((t) => t.id !== tx.id));
                setDayRows((prev) => (prev ? { ...prev, rows: prev.rows.filter((t) => t.id !== tx.id) } : prev));
                if (view === "calendar") fetchCalendar(monthKey);
              }
            } catch {
              Alert.alert("Error", "Cannot connect to server");
            }
          },
        },
      ]
    );
  };

  const renderRow = (item: Transaction) => {
    const positive = item.amount >= 0;
    const subtitle = item.categoryName
      ? `${formatShortDate(item.date)} · ${item.categoryName}`
      : formatShortDate(item.date);
    return (
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={() => navigation.navigate("TransactionDetail", { transaction: item })}
        onLongPress={() => {
          Alert.alert(safeName(item.payee || item.note, "Transaction"), formatCurrency(item.amount, item.currency), [
            {
              text: "Edit",
              onPress: () => navigation.navigate("TransactionDetail", { transaction: item }),
            },
            { text: "Delete", style: "destructive", onPress: () => handleDelete(item) },
            { text: "Cancel", style: "cancel" },
          ]);
        }}
      >
        <View style={[styles.row, { borderBottomColor: colors.border }]}>
          <View
            style={[
              styles.indicator,
              { backgroundColor: (positive ? colors.pos : colors.destructive) + "22" },
            ]}
          >
            <Text style={{ fontSize: 14, color: positive ? colors.pos : colors.destructive }}>
              {positive ? "↑" : "↓"}
            </Text>
          </View>
          <View style={styles.left}>
            <Text style={[styles.payee, { color: colors.foreground }]} numberOfLines={1}>
              {safeName(item.payee || item.note, "Transaction")}
            </Text>
            <Text style={[styles.date, { color: colors.mutedForeground }]} numberOfLines={1}>
              {subtitle}
            </Text>
          </View>
          <View style={styles.right}>
            <Text style={[styles.amount, { color: positive ? colors.pos : colors.foreground }]}>
              {formatCurrency(item.amount, item.currency)}
            </Text>
            <Text style={[styles.chevron, { color: colors.mutedForeground }]}>›</Text>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  // ── views ────────────────────────────────────────────────────────────────
  const listView = (
    <>
      {/* Search Bar */}
      <View style={[styles.searchContainer, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.searchIcon, { color: colors.mutedForeground }]}>⌕</Text>
        <TextInput
          style={[styles.searchInput, { color: colors.foreground }]}
          value={search}
          onChangeText={setSearch}
          placeholder="Search transactions..."
          placeholderTextColor={colors.mutedForeground}
          returnKeyType="search"
          onSubmitEditing={() => fetchTransactions()}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => setSearch("")}>
            <Text style={[styles.clearBtn, { color: colors.mutedForeground }]}>✕</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Hint */}
      <Text style={[styles.hint, { color: colors.mutedForeground }]}>
        Tap to view • Long press for actions
      </Text>

      {/* The list is ALWAYS rendered with flex:1 (mirrors AccountDetailScreen).
          Loading/error/empty are handled by ListEmptyComponent so the FlatList
          never collapses to zero height behind a conditional. */}
      <FlatList
        style={styles.flatList}
        data={transactions}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => renderRow(item)}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => fetchTransactions(true)} />
        }
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator style={{ marginTop: 32 }} size="large" color={colors.primary} />
          ) : error ? (
            <Text style={[styles.empty, { color: colors.destructive }]}>{error}</Text>
          ) : (
            <Text style={[styles.empty, { color: colors.mutedForeground }]}>
              {search ? "No matching transactions" : "No transactions yet"}
            </Text>
          )
        }
      />
    </>
  );

  const dayCountLabel = (n: number) => `${n} transaction${n === 1 ? "" : "s"}`;

  const dayView = cal.day != null && (
    <View>
      <Text style={[styles.dayTitle, { color: colors.foreground }]}>{dayTitle(cal.year, cal.month, cal.day)}</Text>
      {selectedSummary ? (
        <Text style={[styles.daySub, { color: colors.mutedForeground }]}>
          {[
            dayCountLabel(selectedSummary.count),
            selectedSummary.income ? `income ${formatCurrency(selectedSummary.income, currency)}` : null,
            selectedSummary.spending ? `spending ${formatCurrency(selectedSummary.spending, currency)}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      ) : null}
      {dayErrorMessage ? (
        <View style={[styles.banner, { backgroundColor: colors.card, borderColor: colors.destructive }]}>
          <Text style={[styles.bannerText, { color: colors.destructive }]}>{dayErrorMessage}</Text>
          <TouchableOpacity
            style={[styles.retryBtn, { borderColor: colors.border }]}
            onPress={() => selectedIso && fetchDay(selectedIso)}
            accessibilityRole="button"
          >
            <Text style={[styles.retryText, { color: colors.primary }]}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : dayList == null ? (
        <ActivityIndicator style={{ marginTop: 16 }} color={colors.primary} />
      ) : dayList.length === 0 ? (
        <Text style={[styles.empty, { color: colors.mutedForeground }]}>No transactions on this day.</Text>
      ) : (
        <>
          {dayList.map((item) => (
            <React.Fragment key={item.id}>{renderRow(item)}</React.Fragment>
          ))}
          <Text style={[styles.hint, styles.dayHint, { color: colors.mutedForeground }]}>
            {dayList.length >= DAY_LIMIT
              ? `Showing the first ${DAY_LIMIT} · tap to view · long press for actions`
              : "Tap to view • Long press for actions"}
          </Text>
        </>
      )}
    </View>
  );

  const calendarView = (
    <ScrollView
      style={styles.flatList}
      contentContainerStyle={styles.calScroll}
      refreshControl={<RefreshControl refreshing={calRefreshing} onRefresh={refreshCalendar} />}
    >
      {calError ? (
        <View style={[styles.banner, { backgroundColor: colors.card, borderColor: colors.destructive }]}>
          <Text style={[styles.bannerText, { color: colors.destructive }]}>
            {monthData ? `${calError} — showing your last loaded data.` : calError}
          </Text>
          <TouchableOpacity
            style={[styles.retryBtn, { borderColor: colors.border }]}
            onPress={() => fetchCalendar(monthKey)}
            accessibilityRole="button"
          >
            <Text style={[styles.retryText, { color: colors.primary }]}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <View style={[styles.calCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <MonthCalendar
          year={cal.year}
          month={cal.month}
          today={today}
          selectedDay={cal.day}
          onSelectDay={(day) => setCal((c) => ({ ...c, day }))}
          onShiftMonth={shiftMonth}
          onToday={goToToday}
          cellHeight={56}
          dayLabel={(day) => {
            const d = byDay.get(day);
            if (!d) return "";
            const parts = [dayCountLabel(d.count)];
            if (d.income) parts.push(`income ${formatCurrency(d.income, currency)}`);
            if (d.spending) parts.push(`spending ${formatCurrency(d.spending, currency)}`);
            return parts.join(", ");
          }}
          renderDay={(day) => {
            const d = byDay.get(day);
            if (!d) return null;
            // Phone width: dots + the day's count (amounts don't fit a cell).
            return (
              <>
                <View style={styles.calDots}>
                  {d.income > 0 && <View testID={`income-dot-${day}`} style={[styles.calDot, { backgroundColor: colors.pos }]} />}
                  {d.spending > 0 && <View testID={`spending-dot-${day}`} style={[styles.calDot, { backgroundColor: colors.neg }]} />}
                  {!(d.income > 0) && !(d.spending > 0) && (
                    <View style={[styles.calDot, { backgroundColor: colors.mutedForeground }]} />
                  )}
                </View>
                <Text style={[styles.calCount, { color: colors.mutedForeground }]}>{d.count}</Text>
              </>
            );
          }}
        />
        <View style={styles.legend}>
          {[
            { label: "Income", color: colors.pos },
            { label: "Spending", color: colors.neg },
          ].map((l) => (
            <View key={l.label} style={styles.legendItem}>
              <View style={[styles.calDot, { backgroundColor: l.color }]} />
              <Text style={[styles.legendText, { color: colors.mutedForeground }]}>{l.label}</Text>
            </View>
          ))}
          <View style={styles.legendItem}>
            <Text style={[styles.calCount, styles.legendCount, { color: colors.mutedForeground }]}>#</Text>
            <Text style={[styles.legendText, { color: colors.mutedForeground }]}>Transactions</Text>
          </View>
        </View>
        {calLoading ? (
          <ActivityIndicator style={styles.calSpinner} size="small" color={colors.primary} />
        ) : null}
      </View>

      {cal.day != null ? (
        dayView
      ) : (
        <>
          <View style={styles.tiles}>
            <StatTile label="Income" value={money(totals.income)} color={colors.pos} />
            <StatTile label="Spending" value={money(totals.spending)} color={colors.neg} />
            <StatTile
              label="Net"
              value={monthData && net > 0 ? `+${money(net)}` : money(net)}
              color={!monthData ? undefined : net >= 0 ? colors.pos : colors.neg}
            />
            <StatTile label="Transactions" value={monthData ? String(totals.count) : "—"} />
          </View>
          <Text style={[styles.hint, styles.calHint, { color: colors.mutedForeground }]}>
            Tap a day to see its transactions. Transfers between your accounts and investment trades are counted but
            aren't income or spending. Totals in {currency}.
          </Text>
        </>
      )}
    </ScrollView>
  );

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      {/* Header */}
      <View style={styles.headerRow}>
        <Text style={[styles.header, { color: colors.foreground }]}>Transactions</Text>
        <TouchableOpacity
          style={[styles.addBtn, { backgroundColor: colors.primary }]}
          onPress={() => navigation.navigate("AddTransaction")}
        >
          <Text style={[styles.addBtnText, { color: colors.primaryForeground }]}>+ Add</Text>
        </TouchableOpacity>
      </View>

      {/* List / Calendar toggle — same control as the Subscriptions screen. */}
      <View style={[styles.segment, { backgroundColor: colors.secondary }]}>
        {(["list", "calendar"] as View_[]).map((v) => (
          <TouchableOpacity
            key={v}
            onPress={() => setView(v)}
            style={[styles.segmentBtn, view === v && { backgroundColor: colors.card }]}
            accessibilityState={{ selected: view === v }}
          >
            <Text style={[styles.segmentText, { color: view === v ? colors.foreground : colors.mutedForeground }]}>
              {v === "list" ? "List" : "Calendar"}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {view === "list" ? listView : calendarView}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flatList: { flex: 1 },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  header: { fontSize: 28, fontWeight: "800" },
  addBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  addBtnText: { fontSize: 14, fontWeight: "700" },
  segment: { flexDirection: "row", borderRadius: 10, padding: 3, marginHorizontal: 16, marginBottom: 8 },
  segmentBtn: { flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: 8 },
  segmentText: { fontSize: 14, fontWeight: "700" },
  searchContainer: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 16,
    marginBottom: 4,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    height: 40,
  },
  searchIcon: { fontSize: 16, marginRight: 8 },
  searchInput: { flex: 1, fontSize: 15, paddingVertical: 0 },
  clearBtn: { fontSize: 14, padding: 4 },
  hint: { fontSize: 11, textAlign: "center", marginBottom: 4 },
  list: { paddingHorizontal: 16, paddingBottom: 32 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  indicator: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  left: { flex: 1, marginRight: 12 },
  right: { flexDirection: "row", alignItems: "center", gap: 6 },
  payee: { fontSize: 15, fontWeight: "500" },
  date: { fontSize: 12, marginTop: 2 },
  amount: { fontSize: 15, fontWeight: "600", fontVariant: ["tabular-nums"] },
  chevron: { fontSize: 20, fontWeight: "300" },
  empty: { textAlign: "center", paddingVertical: 32, fontSize: 14 },
  // Calendar view
  calScroll: { paddingHorizontal: 16, paddingBottom: 40 },
  calCard: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 8,
    overflow: "hidden",
    padding: 10,
  },
  calDots: { flexDirection: "row", marginTop: 3, height: 6 },
  calDot: { width: 6, height: 6, borderRadius: 3, marginHorizontal: 1 },
  calCount: { fontSize: 10, fontWeight: "600", marginTop: 2, fontVariant: ["tabular-nums"] },
  legendCount: { marginTop: 0 },
  calSpinner: { marginTop: 6 },
  calHint: { fontSize: 12, marginTop: 4, lineHeight: 17, paddingHorizontal: 8 },
  legend: { flexDirection: "row", justifyContent: "center", flexWrap: "wrap", marginTop: 8 },
  legendItem: { flexDirection: "row", alignItems: "center", marginHorizontal: 6 },
  legendText: { fontSize: 11, marginLeft: 4 },
  tiles: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", marginTop: 4 },
  dayTitle: { fontSize: 16, fontWeight: "700", marginTop: 8 },
  daySub: { fontSize: 12, marginTop: 2, marginBottom: 4 },
  dayHint: { marginTop: 8 },
  banner: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    marginBottom: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  bannerText: { flex: 1, fontSize: 13, lineHeight: 18 },
  retryBtn: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  retryText: { fontSize: 13, fontWeight: "700" },
});
