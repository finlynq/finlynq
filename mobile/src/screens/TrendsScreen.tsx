// Trends — income vs expenses over time. Owns its own granularity
// (daily/weekly/monthly/quarterly) + group-by (category/group) controls; the
// date range + business-only filter are inherited from the hub via route
// params. Renders an income/expense line, per-period grouped bars, and the
// grouped income + expense category tables. Reads GET /api/reports/trends
// (bare JSON; amounts are NOT FX-converted server-side — matches web).
import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  Dimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Polyline, Line } from "react-native-svg";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { formatCurrency, formatShortDate } from "../lib/format";
import { scalePoints, seriesRange } from "../lib/portfolio/chart";
import { Icon } from "../components/icon";
import { MetricGrid, type MetricItem } from "../components/portfolio/MetricGrid";
import { TrendBars } from "../components/reports/TrendBars";
import { GroupedCategoryTable, type GroupedRow } from "../components/reports/GroupedCategoryTable";
import type { MoreStackParamList } from "../navigation/MoreStack";
import type { ReportTrends, ReportPeriod, ReportGroupBy, TrendsBreakdownItem } from "../../../shared/types";

type Props = NativeStackScreenProps<MoreStackParamList, "Trends">;

const PERIODS: { key: ReportPeriod; label: string }[] = [
  { key: "daily", label: "Daily" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
  { key: "quarterly", label: "Quarterly" },
];

const toRows = (rows: TrendsBreakdownItem[]): GroupedRow[] =>
  rows.map((r) => ({ name: r.name, group: r.group, total: r.total, count: r.count }));

export default function TrendsScreen({ navigation, route }: Props) {
  const { colors } = useTheme();
  const { startDate, endDate, isBusiness, displayCurrency, rangeLabel } = route.params;

  const [period, setPeriod] = useState<ReportPeriod>("monthly");
  const [groupBy, setGroupBy] = useState<ReportGroupBy>("category");
  const [data, setData] = useState<ReportTrends | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    endpoints
      .getReportTrends({ startDate, endDate, isBusiness, period, groupBy })
      .then((res) => {
        if (cancelled) return;
        if (res.success) {
          setData(res.data);
          setError(null);
        } else {
          logger.warn("trends", "fetch failed", { error: res.error });
          setError(res.error);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        logger.error("trends", "fetch threw", { detail: String(e) });
        setError("Cannot connect to server");
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [startDate, endDate, isBusiness, period, groupBy]);

  const metrics: MetricItem[] = data
    ? [
        { label: "Income", value: formatCurrency(data.totalIncome, displayCurrency, { decimals: 0 }), tone: "pos" },
        { label: "Expenses", value: formatCurrency(data.totalExpenses, displayCurrency, { decimals: 0 }), tone: "neg" },
        {
          label: "Net",
          value: formatCurrency(data.netSavings, displayCurrency, { decimals: 0 }),
          tone: data.netSavings >= 0 ? "pos" : "neg",
        },
        { label: "Savings rate", value: `${data.savingsRate.toFixed(0)}%`, tone: data.savingsRate >= 0 ? "pos" : "neg" },
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

      <ScrollView contentContainerStyle={styles.scroll}>
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
              <TrendLine points={data.timeseries} currency={displayCurrency} />
            </View>

            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>Per-period breakdown</Text>
              <TrendBars points={data.timeseries} />
            </View>

            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>
              Income {groupBy === "group" ? "groups" : "categories"}
            </Text>
            <GroupedCategoryTable rows={toRows(data.income)} currency={displayCurrency} tone="pos" emptyText="No income in this range." />

            <Text style={[styles.sectionTitle, { color: colors.foreground, marginTop: 20 }]}>
              Expense {groupBy === "group" ? "groups" : "categories"}
            </Text>
            <GroupedCategoryTable rows={toRows(data.expenses)} currency={displayCurrency} tone="neg" emptyText="No expenses in this range." />
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
  const { min, max } = seriesRange([inc, exp, [0]]);
  const incPts = scalePoints(inc, min, max, w, h);
  const expPts = scalePoints(exp, min, max, w, h);

  return (
    <View>
      <Svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
        <Line x1={0} y1={h * 0.5} x2={w} y2={h * 0.5} stroke={colors.border} strokeWidth={1} />
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
