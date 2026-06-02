// Reports hub. Owns the shared date-range + business-only filters, shows a
// summary (income/expense/net/savings-rate grid + net-worth/assets/liabilities
// card from the FX-converted income-statement + balance-sheet routes), and
// links to the five detail screens. The display currency is read off the
// income-statement response and threaded to every detail screen as a route
// param (trends/sankey/yoy responses carry no currency field).
import React, { useCallback, useEffect, useState } from "react";
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
import { Icon, type IconName } from "../components/icon";
import { MetricGrid, type MetricItem } from "../components/portfolio/MetricGrid";
import { DateRangePicker, type RangeValue } from "../components/reports/DateRangePicker";
import { getPresetRange, formatRangeLabel } from "../lib/reports/date-range";
import type { MoreStackParamList } from "../navigation/MoreStack";
import type { IncomeStatement, BalanceSheet } from "../../../shared/types";

type Nav = NativeStackNavigationProp<MoreStackParamList, "Reports">;

function initialRange(): RangeValue {
  const r = getPresetRange("ytd");
  return { preset: "ytd", startDate: r.start, endDate: r.end };
}

export default function ReportsScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation<Nav>();

  const [range, setRange] = useState<RangeValue>(initialRange);
  const [isBusiness, setIsBusiness] = useState(false);
  const [income, setIncome] = useState<IncomeStatement | null>(null);
  const [balance, setBalance] = useState<BalanceSheet | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const displayCurrency = income?.displayCurrency ?? balance?.displayCurrency ?? "CAD";

  const load = useCallback(async () => {
    setError(null);
    const [isRes, bsRes] = await Promise.all([
      endpoints.getIncomeStatement({
        startDate: range.startDate,
        endDate: range.endDate,
        isBusiness,
      }),
      endpoints.getBalanceSheet({ endDate: range.endDate }),
    ]);
    if (isRes.success) setIncome(isRes.data);
    else logger.warn("reports", "income-statement fetch failed", { error: isRes.error });
    if (bsRes.success) setBalance(bsRes.data);
    else logger.warn("reports", "balance-sheet fetch failed", { error: bsRes.error });
    if (!isRes.success && !bsRes.success) {
      setError(isRes.success ? "" : isRes.error);
    }
  }, [range.startDate, range.endDate, isBusiness]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load().finally(() => setRefreshing(false));
  }, [load]);

  const metrics: MetricItem[] = income
    ? [
        { label: "Income", value: formatCurrency(income.totalIncome, displayCurrency, { decimals: 0 }), tone: "pos" },
        { label: "Expenses", value: formatCurrency(income.totalExpenses, displayCurrency, { decimals: 0 }), tone: "neg" },
        {
          label: "Net savings",
          value: formatCurrency(income.netSavings, displayCurrency, { decimals: 0 }),
          tone: income.netSavings >= 0 ? "pos" : "neg",
        },
        {
          label: "Savings rate",
          value: `${income.savingsRate.toFixed(0)}%`,
          tone: income.savingsRate >= 0 ? "pos" : "neg",
        },
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
      icon: "reports",
      label: "Income statement",
      sub: "Income & expenses by category",
      onPress: () => navigation.navigate("IncomeStatement", rangeParams),
    },
    {
      icon: "bank",
      label: "Balance sheet",
      sub: "Assets, liabilities & net worth",
      onPress: () => navigation.navigate("BalanceSheet", { endDate: range.endDate, displayCurrency }),
    },
    {
      icon: "performance",
      label: "Trends",
      sub: "Income vs expenses over time",
      onPress: () => navigation.navigate("Trends", rangeParams),
    },
    // Cash flow / Year over year links are added in later phases.
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
        ) : error ? (
          <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text>
        ) : (
          <>
            {metrics.length > 0 && (
              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>SUMMARY</Text>
                <MetricGrid items={metrics} />
              </View>
            )}

            {balance && (
              <View style={[styles.netWorthCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Text style={[styles.nwLabel, { color: colors.mutedForeground }]}>Net worth</Text>
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
  error: { fontSize: 14, textAlign: "center", paddingVertical: 32 },
});
