// Cash-flow Sankey — where income flows to expenses. Reads GET /api/reports/
// trends (the income/expense category aggregates are period-independent totals,
// FX-converted to the display currency the response echoes) and renders the
// SankeyChart from them. Income sources are sorted desc; expense uses keep the
// top 10 and fold the rest into an "Other (n)" node, and a deficit period gets
// a "From savings" source — so the diagram's totals always match the summary
// printed under it (web drops the tail and lets deficit bands overflow).
import React, { useCallback, useMemo } from "react";
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
import { formatCurrency, safeName } from "../lib/format";
import { useReportData } from "../lib/reports/use-report-data";
import { Icon } from "../components/icon";
import { SankeyChart } from "../components/reports/SankeyChart";
import { capSankeyExpenses, type SankeyDatum } from "../lib/reports/sankey";
import type { MoreStackParamList } from "../navigation/MoreStack";

type Props = NativeStackScreenProps<MoreStackParamList, "CashFlowSankey">;

const EXPENSE_CAP = 10;

export default function CashFlowSankeyScreen({ navigation, route }: Props) {
  const { colors } = useTheme();
  const { startDate, endDate, isBusiness, displayCurrency, rangeLabel } = route.params;

  const fetcher = useCallback(
    () => endpoints.getReportTrends({ startDate, endDate, isBusiness, period: "monthly", groupBy: "category" }),
    [startDate, endDate, isBusiness]
  );
  const { data, loading, refreshing, error, refresh } = useReportData(fetcher, "sankey");
  const ccy = data?.displayCurrency ?? displayCurrency;

  const sankeyIncome: SankeyDatum[] = useMemo(
    () =>
      (data?.income ?? [])
        .filter((r) => r.total > 0)
        .sort((a, z) => z.total - a.total)
        .map((r) => ({ name: safeName(r.name), value: r.total })),
    [data]
  );

  const { data: sankeyExpenses, foldedCount } = useMemo(
    () =>
      capSankeyExpenses(
        (data?.expenses ?? []).map((r) => ({ name: safeName(r.name), value: r.total })),
        EXPENSE_CAP
      ),
    [data]
  );

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
          <Icon name="back" size={20} color={colors.primary} />
          <Text style={[styles.backText, { color: colors.primary }]}>Reports</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.foreground }]}>Cash flow</Text>
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
            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.cardHint, { color: colors.mutedForeground }]}>
                Swipe the diagram sideways to see all flows.
              </Text>
              <SankeyChart incomeData={sankeyIncome} expenseData={sankeyExpenses} currency={ccy} />
            </View>

            {foldedCount > 0 && (
              <Text style={[styles.note, { color: colors.mutedForeground }]}>
                Showing the top {EXPENSE_CAP} expense categories · the {foldedCount} smaller ones are
                combined into “Other ({foldedCount})”.
              </Text>
            )}

            <View style={[styles.summary, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <SummaryRow label="Income" value={data.totalIncome} ccy={ccy} color={colors.pos} />
              <SummaryRow label="Expenses" value={data.totalExpenses} ccy={ccy} color={colors.neg} border />
              <SummaryRow
                label="Net savings"
                value={data.netSavings}
                ccy={ccy}
                color={data.netSavings >= 0 ? colors.pos : colors.neg}
                border
                bold
              />
            </View>
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function SummaryRow({
  label,
  value,
  ccy,
  color,
  border,
  bold,
}: {
  label: string;
  value: number;
  ccy: string;
  color: string;
  border?: boolean;
  bold?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View
      style={[
        styles.summaryRow,
        border && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
      ]}
    >
      <Text style={[styles.summaryLabel, { color: colors.mutedForeground, fontWeight: bold ? "700" : "500" }]}>
        {label}
      </Text>
      <Text style={[styles.summaryVal, { color, fontWeight: bold ? "800" : "700" }]}>
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
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 12 },
  cardHint: { fontSize: 11, marginBottom: 8 },
  note: { fontSize: 12, marginTop: 10, lineHeight: 17 },
  summary: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 14, marginTop: 16 },
  summaryRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 10 },
  summaryLabel: { fontSize: 14 },
  summaryVal: { fontSize: 15, fontVariant: ["tabular-nums"] },
  error: { fontSize: 14, textAlign: "center", paddingVertical: 32 },
});
