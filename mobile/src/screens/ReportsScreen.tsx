// Reports hub. Owns the shared date-range + business-only filters, shows a
// summary (income/expense/net/savings-rate grid from the FX-converted income
// statement for the range) and a net-worth card (the balance sheet, which is
// always TODAY's balances — the server ignores the range), and links to the
// detail screens. The display currency is read off the responses and threaded
// to every detail screen as a route param — only a fallback there, since every
// report route now echoes its own `displayCurrency`.
//
// Each card loads independently: a failed fetch shows an inline error in ITS
// card (the other still renders), and a request-sequence guard drops a slower
// earlier response so a previous range's numbers can never land under a newer
// range's filters.
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Switch,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { formatCurrency } from "../lib/format";
import { localDateISO } from "../lib/subscriptions";
import { formatSavingsRate } from "../lib/reports/savings-rate";
import { Icon, type IconName } from "../components/icon";
import { MetricGrid, type MetricItem } from "../components/portfolio/MetricGrid";
import { DateRangePicker, type RangeValue } from "../components/reports/DateRangePicker";
import { getPresetRange, formatRangeLabel } from "../lib/reports/date-range";
import type { MoreStackParamList } from "../navigation/MoreStack";
import type { ApiResponse, IncomeStatement, BalanceSheet } from "../../../shared/types";

type Nav = NativeStackNavigationProp<MoreStackParamList, "Reports">;

const NETWORK_ERROR = "Cannot connect to server";

function initialRange(): RangeValue {
  const r = getPresetRange("ytd");
  return { preset: "ytd", startDate: r.start, endDate: r.end };
}

/** A fetch that rejects (rather than resolving { success:false }) still
 *  becomes a per-card error instead of escaping the handler. */
function settle<T>(p: Promise<ApiResponse<T>>, tag: string): Promise<ApiResponse<T>> {
  return p.catch((e): ApiResponse<T> => {
    logger.error("reports", `${tag} fetch threw`, { detail: String(e) });
    return { success: false, error: NETWORK_ERROR };
  });
}

export default function ReportsScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation<Nav>();

  const [range, setRange] = useState<RangeValue>(initialRange);
  const [isBusiness, setIsBusiness] = useState(false);
  const [income, setIncome] = useState<IncomeStatement | null>(null);
  const [balance, setBalance] = useState<BalanceSheet | null>(null);
  const [incomeError, setIncomeError] = useState<string | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const reqSeq = useRef(0);

  const displayCurrency = income?.displayCurrency ?? balance?.displayCurrency ?? "USD";

  const load = useCallback(
    async (mode: "load" | "refresh") => {
      const seq = ++reqSeq.current;
      if (mode === "load") setLoading(true);
      else setRefreshing(true);
      const [isRes, bsRes] = await Promise.all([
        settle(
          endpoints.getIncomeStatement({ startDate: range.startDate, endDate: range.endDate, isBusiness }),
          "income-statement"
        ),
        // The balance sheet is always current balances; ask for today rather
        // than the range end so the request says what the server returns.
        settle(endpoints.getBalanceSheet({ endDate: localDateISO() }), "balance-sheet"),
      ]);
      // A newer request (range/filter change or refresh) owns the screen now.
      if (seq !== reqSeq.current) return;

      if (isRes.success) {
        setIncome(isRes.data);
        setIncomeError(null);
      } else {
        logger.warn("reports", "income-statement fetch failed", { error: isRes.error });
        setIncome(null); // never leave the previous range's summary on screen
        setIncomeError(isRes.error || "Couldn't load the summary");
      }
      if (bsRes.success) {
        setBalance(bsRes.data);
        setBalanceError(null);
      } else {
        logger.warn("reports", "balance-sheet fetch failed", { error: bsRes.error });
        setBalance(null);
        setBalanceError(bsRes.error || "Couldn't load net worth");
      }
      setLoading(false);
      setRefreshing(false);
    },
    [range.startDate, range.endDate, isBusiness]
  );

  useEffect(() => {
    void load("load");
    return () => {
      // Filter change or unmount → whatever is in flight is stale.
      reqSeq.current++;
    };
  }, [load]);

  const onRefresh = useCallback(() => {
    void load("refresh");
  }, [load]);

  const rate = income ? formatSavingsRate(income.totalIncome, income.savingsRate) : null;
  const metrics: MetricItem[] = income
    ? [
        { label: "Income", value: formatCurrency(income.totalIncome, displayCurrency, { decimals: 0 }), tone: "pos" },
        { label: "Expenses", value: formatCurrency(income.totalExpenses, displayCurrency, { decimals: 0 }), tone: "neg" },
        {
          label: "Net savings",
          value: formatCurrency(income.netSavings, displayCurrency, { decimals: 0 }),
          tone: income.netSavings >= 0 ? "pos" : "neg",
        },
        { label: "Savings rate", value: rate!.text, tone: rate!.tone },
      ]
    : [];

  const rangeParams = {
    startDate: range.startDate,
    endDate: range.endDate,
    isBusiness,
    displayCurrency,
    rangeLabel: formatRangeLabel(range.startDate, range.endDate),
  };

  const links: { icon: IconName; label: string; sub: string; onPress: () => void }[] = [
    {
      icon: "categories",
      label: "Categories",
      sub: "Where your money goes, month by month",
      onPress: () => navigation.navigate("CategoryReports"),
    },
    {
      icon: "reports",
      label: "Income statement",
      sub: "Income & expenses by category",
      onPress: () => navigation.navigate("IncomeStatement", rangeParams),
    },
    {
      icon: "bank",
      label: "Balance sheet",
      sub: "Assets, liabilities & net worth today",
      onPress: () => navigation.navigate("BalanceSheet", { endDate: localDateISO(), displayCurrency }),
    },
    {
      icon: "performance",
      label: "Trends",
      sub: "Income vs expenses over time",
      onPress: () => navigation.navigate("Trends", rangeParams),
    },
    {
      icon: "fx",
      label: "Cash flow",
      sub: "Sankey: where money flows",
      onPress: () => navigation.navigate("CashFlowSankey", rangeParams),
    },
    {
      icon: "transfer",
      label: "Year over year",
      sub: "Compare two calendar years",
      onPress: () => navigation.navigate("YearOverYear", { displayCurrency }),
    },
  ];

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={styles.headerRow}>
        <Text style={[styles.header, { color: colors.foreground }]}>Reports</Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {/* Filters */}
        <View style={[styles.filterCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <DateRangePicker value={range} onChange={setRange} />
          <View style={[styles.toggleRow, { borderTopColor: colors.border }]}>
            <Text style={[styles.toggleLabel, { color: colors.foreground }]}>Business only</Text>
            <Switch
              value={isBusiness}
              onValueChange={setIsBusiness}
              trackColor={{ true: colors.primary, false: colors.border }}
            />
          </View>
        </View>

        {loading ? (
          <ActivityIndicator style={{ marginTop: 40 }} size="large" color={colors.primary} />
        ) : (
          <>
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>SUMMARY</Text>
              {incomeError ? (
                <CardError message={`Couldn't load the summary: ${incomeError}`} />
              ) : (
                metrics.length > 0 && <MetricGrid items={metrics} />
              )}
            </View>

            {balanceError ? (
              <View style={{ marginBottom: 8 }}>
                <CardError message={`Couldn't load net worth: ${balanceError}`} />
              </View>
            ) : (
              balance && (
                <View style={[styles.netWorthCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <Text style={[styles.nwLabel, { color: colors.mutedForeground }]}>Net worth · today</Text>
                  <Text
                    style={[
                      styles.nwValue,
                      { color: balance.netWorth >= 0 ? colors.foreground : colors.neg },
                    ]}
                  >
                    {formatCurrency(balance.netWorth, displayCurrency, { decimals: 0 })}
                  </Text>
                  <View style={styles.nwSplit}>
                    <View style={styles.nwSplitItem}>
                      <Text style={[styles.nwSplitLabel, { color: colors.mutedForeground }]}>Assets</Text>
                      <Text style={[styles.nwSplitVal, { color: colors.pos }]}>
                        {formatCurrency(balance.totalAssets, displayCurrency, { decimals: 0 })}
                      </Text>
                    </View>
                    <View style={styles.nwSplitItem}>
                      <Text style={[styles.nwSplitLabel, { color: colors.mutedForeground }]}>Liabilities</Text>
                      <Text style={[styles.nwSplitVal, { color: colors.neg }]}>
                        {formatCurrency(balance.totalLiabilities, displayCurrency, { decimals: 0 })}
                      </Text>
                    </View>
                  </View>
                </View>
              )
            )}

            <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>DETAILED REPORTS</Text>
            <View style={[styles.linksCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              {links.map((l, i) => (
                <TouchableOpacity
                  key={l.label}
                  activeOpacity={0.7}
                  onPress={l.onPress}
                  style={[
                    styles.linkRow,
                    i < links.length - 1 && {
                      borderBottomWidth: StyleSheet.hairlineWidth,
                      borderBottomColor: colors.border,
                    },
                  ]}
                >
                  <View style={[styles.linkIcon, { backgroundColor: colors.secondary }]}>
                    <Icon name={l.icon} size={18} color={colors.foreground} />
                  </View>
                  <View style={styles.linkText}>
                    <Text style={[styles.linkLabel, { color: colors.foreground }]}>{l.label}</Text>
                    <Text style={[styles.linkSub, { color: colors.mutedForeground }]} numberOfLines={1}>
                      {l.sub}
                    </Text>
                  </View>
                  <Icon name="chevronRight" size={16} color={colors.mutedForeground} />
                </TouchableOpacity>
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function CardError({ message }: { message: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.cardError, { borderColor: colors.border, backgroundColor: colors.card }]}>
      <Text style={[styles.cardErrorText, { color: colors.destructive }]}>{message}</Text>
      <Text style={[styles.cardErrorHint, { color: colors.mutedForeground }]}>Pull down to retry.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  headerRow: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  header: { fontSize: 28, fontWeight: "800" },
  scroll: { padding: 16, paddingBottom: 32 },
  filterCard: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingTop: 12,
    marginBottom: 16,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 10,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  toggleLabel: { fontSize: 14, fontWeight: "600" },
  section: { marginBottom: 8 },
  sectionTitle: { fontSize: 12, fontWeight: "700", letterSpacing: 0.5, marginBottom: 8, marginTop: 4 },
  netWorthCard: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    marginBottom: 16,
  },
  nwLabel: { fontSize: 13, fontWeight: "600" },
  nwValue: { fontSize: 30, fontWeight: "800", fontVariant: ["tabular-nums"], marginTop: 2 },
  nwSplit: { flexDirection: "row", marginTop: 14, gap: 24 },
  nwSplitItem: {},
  nwSplitLabel: { fontSize: 12 },
  nwSplitVal: { fontSize: 16, fontWeight: "700", fontVariant: ["tabular-nums"], marginTop: 2 },
  linksCard: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  linkRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 13 },
  linkIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  linkText: { flex: 1 },
  linkLabel: { fontSize: 15, fontWeight: "600" },
  linkSub: { fontSize: 12, marginTop: 1 },
  cardError: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: 4,
    marginBottom: 8,
  },
  cardErrorText: { fontSize: 13, fontWeight: "600" },
  cardErrorHint: { fontSize: 12, marginTop: 2 },
});
