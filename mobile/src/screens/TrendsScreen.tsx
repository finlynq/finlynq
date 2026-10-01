// Trends — income vs expenses over time. Owns its own granularity
// (daily/weekly/monthly/quarterly) + group-by (category/group) controls; the
// date range + business-only filter are inherited from the hub via route
// params. Renders an income/expense line, per-period grouped bars, and the
// income + expense breakdown tables. Reads GET /api/reports/trends (bare JSON;
// amounts are FX-converted to the display currency server-side, which the
// response echoes as `displayCurrency`). In category mode each row carries the
// server's `categoryId` and taps through to CategoryDetail; in group mode the
// rows ARE groups, so they render as a flat list (no one-item collapsibles).
import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  Dimensions,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Polyline, Line } from "react-native-svg";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { formatCurrency } from "../lib/format";
import { scalePoints, seriesRange } from "../lib/portfolio/chart";
import { formatSavingsRate } from "../lib/reports/savings-rate";
import { useReportData } from "../lib/reports/use-report-data";
import { Icon } from "../components/icon";
import { MetricGrid, type MetricItem } from "../components/portfolio/MetricGrid";
import { TrendBars } from "../components/reports/TrendBars";
import { GroupedCategoryTable, type GroupedRow } from "../components/reports/GroupedCategoryTable";
import type { MoreStackParamList } from "../navigation/MoreStack";
import type { ReportPeriod, ReportGroupBy, TrendsBreakdownItem } from "../../../shared/types";

type Props = NativeStackScreenProps<MoreStackParamList, "Trends">;

const PERIODS: { key: ReportPeriod; label: string }[] = [
  { key: "daily", label: "Daily" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
  { key: "quarterly", label: "Quarterly" },
];

// Line chart inner vertical padding — must match scalePoints' default padY so
// the zero baseline lands where the series' zero would.
const LINE_PAD_Y = 6;

const toRows = (rows: TrendsBreakdownItem[], mode: ReportGroupBy): GroupedRow[] =>
  rows.map((r) => ({
    name: r.name,
    group: r.group,
    total: r.total,
    count: r.count,
    // Only a category row maps to one category; a group row aggregates many.
    categoryId: mode === "category" ? (r.categoryId ?? null) : null,
  }));

export default function TrendsScreen({ navigation, route }: Props) {
  const { colors } = useTheme();
  const { startDate, endDate, isBusiness, displayCurrency, rangeLabel } = route.params;

  const [period, setPeriod] = useState<ReportPeriod>("monthly");
  const [groupBy, setGroupBy] = useState<ReportGroupBy>("category");

  const fetcher = useCallback(
    () => endpoints.getReportTrends({ startDate, endDate, isBusiness, period, groupBy }),
    [startDate, endDate, isBusiness, period, groupBy]
  );
  const { data, loading, refreshing, error, refresh } = useReportData(fetcher, "trends");

  const ccy = data?.displayCurrency ?? displayCurrency;
  // Render off what the server actually returned, not the chip state.
  const mode: ReportGroupBy = data?.groupBy ?? groupBy;
  const openCategory = (row: GroupedRow) => {
    if (row.categoryId != null) navigation.navigate("CategoryDetail", { categoryId: row.categoryId, name: row.name });
  };

  const rate = data ? formatSavingsRate(data.totalIncome, data.savingsRate) : null;
  const metrics: MetricItem[] = data
    ? [
        { label: "Income", value: formatCurrency(data.totalIncome, ccy, { decimals: 0 }), tone: "pos" },
        { label: "Expenses", value: formatCurrency(data.totalExpenses, ccy, { decimals: 0 }), tone: "neg" },
        {
          label: "Net",
          value: formatCurrency(data.netSavings, ccy, { decimals: 0 }),
          tone: data.netSavings >= 0 ? "pos" : "neg",
        },
        { label: "Savings rate", value: rate!.text, tone: rate!.tone },
      ]
    : [];

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
          <Icon name="back" size={20} color={colors.primary} />
          <Text style={[styles.backText, { color: colors.primary }]}>Reports</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.foreground }]}>Trends</Text>
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

        {/* Granularity */}
        <View style={styles.chipRow}>
          {PERIODS.map((p) => (
            <Chip key={p.key} label={p.label} active={period === p.key} onPress={() => setPeriod(p.key)} />
          ))}
        </View>
        {/* Group by */}
        <View style={styles.chipRow}>
          <Chip label="By category" active={groupBy === "category"} onPress={() => setGroupBy("category")} />
          <Chip label="By group" active={groupBy === "group"} onPress={() => setGroupBy("group")} />
        </View>

        {loading ? (
          <ActivityIndicator style={{ marginTop: 40 }} size="large" color={colors.primary} />
        ) : error ? (
          <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text>
        ) : data ? (
          <>
            {metrics.length > 0 && (
              <View style={{ marginTop: 6, marginBottom: 4 }}>
                <MetricGrid items={metrics} />
              </View>
            )}

            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>Income vs expenses</Text>
              <TrendLine points={data.timeseries} currency={ccy} />
            </View>

            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>Per-period breakdown</Text>
              <TrendBars points={data.timeseries} />
            </View>

            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>
              Income {mode === "group" ? "groups" : "categories"}
            </Text>
            <GroupedCategoryTable
              rows={toRows(data.income, mode)}
              currency={ccy}
              tone="pos"
              emptyText="No income in this range."
              flat={mode === "group"}
              onPressItem={mode === "category" ? openCategory : undefined}
            />

            <Text style={[styles.sectionTitle, { color: colors.foreground, marginTop: 20 }]}>
              Expense {mode === "group" ? "groups" : "categories"}
            </Text>
            <GroupedCategoryTable
              rows={toRows(data.expenses, mode)}
              currency={ccy}
              tone="neg"
              emptyText="No expenses in this range."
              flat={mode === "group"}
              onPressItem={mode === "category" ? openCategory : undefined}
            />
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

// Income (teal) + expense (coral) solid lines on a shared scale.
function TrendLine({
  points,
  currency,
}: {
  points: { label: string; income: number; expenses: number }[];
  currency: string;
}) {
  const { colors } = useTheme();
  const w = Math.max(220, Dimensions.get("window").width - 64);
  const h = 130;

  if (points.length < 2) {
    return (
      <Text style={[styles.lineEmpty, { color: colors.mutedForeground }]}>
        Not enough periods to chart — widen the range or change granularity.
      </Text>
    );
  }

  const inc = points.map((p) => p.income);
  const exp = points.map((p) => p.expenses);
  // [0] keeps zero inside the scale, so the baseline below is always on-chart.
  const { min, max } = seriesRange([inc, exp, [0]]);
  const incPts = scalePoints(inc, min, max, w, h, LINE_PAD_Y);
  const expPts = scalePoints(exp, min, max, w, h, LINE_PAD_Y);
  // A real zero baseline (same mapping scalePoints uses), not a decorative
  // midline that reads like an axis but sits at half the max.
  const span = max - min || 1;
  const zeroY = LINE_PAD_Y + (1 - (0 - min) / span) * Math.max(1, h - LINE_PAD_Y * 2);

  return (
    <View>
      <Svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
        <Line x1={0} y1={zeroY} x2={w} y2={zeroY} stroke={colors.border} strokeWidth={1} />
        <Polyline points={incPts} fill="none" stroke={colors.pos} strokeWidth={2.5} />
        <Polyline points={expPts} fill="none" stroke={colors.neg} strokeWidth={2.5} />
      </Svg>
      <View style={styles.lineLegend}>
        <Text style={[styles.lineDate, { color: colors.mutedForeground }]}>{points[0].label}</Text>
        <Text style={[styles.lineKey, { color: colors.mutedForeground }]}>
          {formatCurrency(max, currency, { decimals: 0 })} max
        </Text>
        <Text style={[styles.lineDate, { color: colors.mutedForeground }]}>
          {points[points.length - 1].label}
        </Text>
      </View>
    </View>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[
        styles.chip,
        { backgroundColor: active ? colors.primary : colors.secondary, borderColor: active ? colors.primary : colors.border },
      ]}
    >
      <Text style={{ color: active ? colors.primaryForeground : colors.foreground, fontSize: 13, fontWeight: "600" }}>
        {label}
      </Text>
    </TouchableOpacity>
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
  rangeLabel: { fontSize: 13, fontWeight: "600", marginBottom: 12 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 },
  chip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    marginTop: 12,
  },
  cardTitle: { fontSize: 15, fontWeight: "700", marginBottom: 12 },
  sectionTitle: { fontSize: 16, fontWeight: "700", marginTop: 20, marginBottom: 10 },
  lineEmpty: { fontSize: 13, textAlign: "center", paddingVertical: 20 },
  lineLegend: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 8 },
  lineDate: { fontSize: 11, fontVariant: ["tabular-nums"] },
  lineKey: { fontSize: 11 },
  error: { fontSize: 14, textAlign: "center", paddingVertical: 32 },
});
