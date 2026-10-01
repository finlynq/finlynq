// Income statement — FX-converted income + expense category tables (grouped,
// collapsible) + a net-savings summary + an optional unrealized-P&L card for
// investment accounts. Reads GET /api/reports?type=income-statement (bare JSON,
// totals converted to the display currency server-side). Each row carries the
// server's `categoryId`, so tapping a category opens its month-by-month detail.
import React, { useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { formatCurrency } from "../lib/format";
import { formatSavingsRate } from "../lib/reports/savings-rate";
import { useReportData } from "../lib/reports/use-report-data";
import { Icon } from "../components/icon";
import { GroupedCategoryTable, type GroupedRow } from "../components/reports/GroupedCategoryTable";
import type { MoreStackParamList } from "../navigation/MoreStack";
import type { IncomeStatementRow } from "../../../shared/types";

type Props = NativeStackScreenProps<MoreStackParamList, "IncomeStatement">;

const toRows = (rows: IncomeStatementRow[]): GroupedRow[] =>
  rows.map((r) => ({ name: r.categoryName, group: r.categoryGroup, total: r.total, count: r.count, categoryId: r.categoryId }));

export default function IncomeStatementScreen({ navigation, route }: Props) {
  const { colors } = useTheme();
  const { startDate, endDate, isBusiness, displayCurrency, rangeLabel } = route.params;

  // Tapping a category opens its month-by-month detail.
  const openCategory = (row: GroupedRow) => {
    if (row.categoryId != null) navigation.navigate("CategoryDetail", { categoryId: row.categoryId, name: row.name });
  };

  const fetcher = useCallback(
    () => endpoints.getIncomeStatement({ startDate, endDate, isBusiness }),
    [startDate, endDate, isBusiness]
  );
  const { data, loading, refreshing, error, refresh } = useReportData(fetcher, "income-statement");

  const ccy = data?.displayCurrency ?? displayCurrency;
  const rate = data ? formatSavingsRate(data.totalIncome, data.savingsRate) : null;
  const unreal = data?.unrealized;
  const hasUnreal = !!unreal && (Math.abs(unreal.totals.totalGL) > 0.005 || unreal.accounts.length > 0);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
          <Icon name="back" size={20} color={colors.primary} />
          <Text style={[styles.backText, { color: colors.primary }]}>Reports</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.foreground }]}>Income statement</Text>
        <View style={{ width: 70 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} />}
      >
        <Text style={[styles.rangeLabel, { color: colors.mutedForeground }]}>
          {rangeLabel}
          {isBusiness ? " · Business only" : ""}
        </Text>

        {loading ? (
          <ActivityIndicator style={{ marginTop: 40 }} size="large" color={colors.primary} />
        ) : error ? (
          <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text>
        ) : data ? (
          <>
            {/* Net savings summary */}
            <View style={[styles.summary, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.summaryRow}>
                <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>Income</Text>
                <Text style={[styles.summaryVal, { color: colors.pos }]}>
                  {formatCurrency(data.totalIncome, ccy, { decimals: 0 })}
                </Text>
              </View>
              <View style={styles.summaryRow}>
                <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>Expenses</Text>
                <Text style={[styles.summaryVal, { color: colors.neg }]}>
                  {formatCurrency(data.totalExpenses, ccy, { decimals: 0 })}
                </Text>
              </View>
              <View style={[styles.summaryRow, styles.summaryNet, { borderTopColor: colors.border }]}>
                <Text style={[styles.summaryLabel, { color: colors.foreground, fontWeight: "700" }]}>
                  Net savings
                </Text>
                <View style={{ alignItems: "flex-end" }}>
                  <Text
                    style={[
                      styles.summaryVal,
                      { color: data.netSavings >= 0 ? colors.pos : colors.neg, fontSize: 18 },
                    ]}
                  >
                    {formatCurrency(data.netSavings, ccy, { decimals: 0 })}
                  </Text>
                  <Text style={[styles.summaryRate, { color: colors.mutedForeground }]}>
                    {rate?.text ?? "—"} savings rate
                  </Text>
                </View>
              </View>
            </View>

            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Income</Text>
            <GroupedCategoryTable rows={toRows(data.income)} currency={ccy} tone="pos" emptyText="No income in this range." onPressItem={openCategory} />

            <Text style={[styles.sectionTitle, { color: colors.foreground, marginTop: 20 }]}>Expenses</Text>
            <GroupedCategoryTable rows={toRows(data.expenses)} currency={ccy} tone="neg" emptyText="No expenses in this range." onPressItem={openCategory} />

            {hasUnreal && unreal && (
              <>
                <Text style={[styles.sectionTitle, { color: colors.foreground, marginTop: 20 }]}>
                  Unrealized gains / losses
                </Text>
                <Text style={[styles.unrealNote, { color: colors.mutedForeground }]}>
                  Period change for investment accounts (end − start snapshot).
                </Text>
                <View style={[styles.unrealCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <UnrealRow label="Valuation" value={unreal.totals.valuationGL} ccy={ccy} />
                  <UnrealRow label="FX" value={unreal.totals.fxGL} ccy={ccy} border />
                  <UnrealRow label="Total" value={unreal.totals.totalGL} ccy={ccy} border bold />
                </View>
              </>
            )}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function UnrealRow({
  label,
  value,
  ccy,
  border,
  bold,
}: {
  label: string;
  value: number;
  ccy: string;
  border?: boolean;
  bold?: boolean;
}) {
  const { colors } = useTheme();
  const color = value > 0 ? colors.pos : value < 0 ? colors.neg : colors.foreground;
  return (
    <View
      style={[
        styles.unrealRow,
        border && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
      ]}
    >
      <Text style={[styles.unrealLabel, { color: colors.mutedForeground, fontWeight: bold ? "700" : "500" }]}>
        {label}
      </Text>
      <Text style={[styles.unrealVal, { color, fontWeight: bold ? "800" : "700" }]}>
        {value >= 0 ? "+" : ""}
        {formatCurrency(value, ccy, { decimals: 0 })}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: { flexDirection: "row", alignItems: "center", gap: 2 },
  backText: { fontSize: 15, fontWeight: "600" },
  title: { fontSize: 17, fontWeight: "700" },
  scroll: { padding: 16, paddingBottom: 32 },
  rangeLabel: { fontSize: 13, fontWeight: "600", marginBottom: 14 },
  summary: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 14, marginBottom: 20 },
  summaryRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 6 },
  summaryNet: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: 4, paddingTop: 12 },
  summaryLabel: { fontSize: 14 },
  summaryVal: { fontSize: 15, fontWeight: "700", fontVariant: ["tabular-nums"] },
  summaryRate: { fontSize: 12, marginTop: 2 },
  sectionTitle: { fontSize: 16, fontWeight: "700", marginBottom: 10 },
  unrealNote: { fontSize: 12, marginBottom: 10, lineHeight: 17 },
  unrealCard: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  unrealRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12 },
  unrealLabel: { fontSize: 14 },
  unrealVal: { fontSize: 15, fontVariant: ["tabular-nums"] },
  error: { fontSize: 14, textAlign: "center", paddingVertical: 32 },
});
