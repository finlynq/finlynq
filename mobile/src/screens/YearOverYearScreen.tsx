// Year over year — compare two calendar years. Reads GET /api/reports/yoy
// (year1/year2 → category expense comparison + per-month income/expense totals
// for both years). This is the same dedicated endpoint the web /reports YoY tab
// uses (NOT two shifted trends calls). Amounts are FX-converted to the display
// currency server-side (echoed as `displayCurrency`). For expenses, a
// year-over-year INCREASE is colored coral and a decrease teal (lower spending
// is the good direction).
//
// Partial year: when either side is the current year, the totals compare
// Jan → current month on BOTH sides (like for like), the current year's future
// months show "—", and its header reads "YYYY YTD". The category comparison is
// full calendar years server-side, so it gets a caveat line instead.
import React, { useCallback, useMemo, useState } from "react";
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
import type { MoreStackParamList } from "../navigation/MoreStack";

type Props = NativeStackScreenProps<MoreStackParamList, "YearOverYear">;

function recentYears(): number[] {
  const y = new Date().getFullYear();
  return [y, y - 1, y - 2, y - 3, y - 4];
}

export default function YearOverYearScreen({ navigation, route }: Props) {
  const { colors } = useTheme();
  const { displayCurrency } = route.params;
  const years = useMemo(recentYears, []);

  const [year1, setYear1] = useState(years[1]); // prior year
  const [year2, setYear2] = useState(years[0]); // current year

  const fetcher = useCallback(() => endpoints.getYoY({ year1, year2 }), [year1, year2]);
  const { data, loading, refreshing, error, refresh } = useReportData(fetcher, "yoy");
  const ccy = data?.displayCurrency ?? displayCurrency;

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonthIdx = now.getMonth(); // 0-based
  const hasCurrentYear = !!data && (data.year1 === currentYear || data.year2 === currentYear);
  // Months (0-based) included in the totals: all 12, or Jan → this month.
  const lastMonthIdx = hasCurrentYear ? currentMonthIdx : 11;
  const isFutureMonth = (year: number, idx: number) => year === currentYear && idx > currentMonthIdx;
  const yearLabel = (y: number) => (y === currentYear ? `${y} YTD` : String(y));
  const throughMonth = data?.monthly[currentMonthIdx]?.month ?? "";
  // Category totals are full calendar years server-side — only a real mismatch
  // (one side partial, the other a finished year) needs the caveat.
  const categoryCaveat = !!data && hasCurrentYear && data.year1 !== data.year2;

  // Year totals from the monthly rows, limited to the like-for-like window.
  const totals = useMemo(() => {
    const m = (data?.monthly ?? []).filter((_, i) => i <= lastMonthIdx);
    return {
      income1: m.reduce((s, r) => s + r.year1Income, 0),
      expenses1: m.reduce((s, r) => s + r.year1Expenses, 0),
      income2: m.reduce((s, r) => s + r.year2Income, 0),
      expenses2: m.reduce((s, r) => s + r.year2Expenses, 0),
    };
  }, [data, lastMonthIdx]);

  const categories = useMemo(
    () => (data?.categories ?? []).filter((c) => c.year1Amount > 0 || c.year2Amount > 0),
    [data]
  );

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
          <Icon name="back" size={20} color={colors.primary} />
          <Text style={[styles.backText, { color: colors.primary }]}>Reports</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.foreground }]}>Year over year</Text>
        <View style={{ width: 70 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} />}
      >
        <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>BASE YEAR</Text>
        <View style={styles.chipRow}>
          {years.map((y) => (
            <Chip key={`y1-${y}`} label={String(y)} active={year1 === y} onPress={() => setYear1(y)} />
          ))}
        </View>
        <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>COMPARE YEAR</Text>
        <View style={styles.chipRow}>
          {years.map((y) => (
            <Chip key={`y2-${y}`} label={String(y)} active={year2 === y} onPress={() => setYear2(y)} />
          ))}
        </View>

        {loading ? (
          <ActivityIndicator style={{ marginTop: 40 }} size="large" color={colors.primary} />
        ) : error ? (
          <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text>
        ) : data ? (
          <>
            {/* Year totals comparison */}
            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.totalsHead}>
                <Text style={[styles.totalsHeadLabel, { color: colors.mutedForeground }]} />
                <Text style={[styles.totalsHeadYear, { color: colors.mutedForeground }]}>{yearLabel(data.year1)}</Text>
                <Text style={[styles.totalsHeadYear, { color: colors.foreground }]}>{yearLabel(data.year2)}</Text>
              </View>
              <TotalsRow label="Income" v1={totals.income1} v2={totals.income2} ccy={ccy} />
              <TotalsRow label="Expenses" v1={totals.expenses1} v2={totals.expenses2} ccy={ccy} border />
              <TotalsRow
                label="Net"
                v1={totals.income1 - totals.expenses1}
                v2={totals.income2 - totals.expenses2}
                ccy={ccy}
                border
                bold
              />
            </View>
            {hasCurrentYear && data.year1 !== data.year2 && (
              <Text style={[styles.caption, { color: colors.mutedForeground }]}>
                Totals cover Jan–{throughMonth} of both years, so {currentYear} YTD compares like for like.
              </Text>
            )}

            {/* Expense category comparison */}
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Expense categories</Text>
            {categoryCaveat && categories.length > 0 && (
              <Text style={[styles.caption, { color: colors.mutedForeground }]}>
                Category amounts are full calendar years: {currentYear} only runs through {throughMonth}, so these %
                changes compare a partial year with a full one.
              </Text>
            )}
            {categories.length === 0 ? (
              <Text style={[styles.empty, { color: colors.mutedForeground }]}>
                No expense categories in these years.
              </Text>
            ) : (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                {categories.map((c, i) => {
                  // For expenses: spending more (positive change) is bad → coral.
                  const up = c.change > 0;
                  const flat = Math.abs(c.change) < 0.5;
                  const changeColor = flat ? colors.mutedForeground : up ? colors.neg : colors.pos;
                  return (
                    <View
                      key={c.name + i}
                      style={[
                        styles.catRow,
                        i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
                      ]}
                    >
                      <Text style={[styles.catName, { color: colors.foreground }]} numberOfLines={1}>
                        {safeName(c.name)}
                      </Text>
                      <View style={styles.catAmounts}>
                        <Text style={[styles.catVal, { color: colors.mutedForeground }]}>
                          {formatCurrency(c.year1Amount, ccy, { decimals: 0 })}
                        </Text>
                        <Icon name="chevronRight" size={12} color={colors.mutedForeground} />
                        <Text style={[styles.catVal, { color: colors.foreground }]}>
                          {formatCurrency(c.year2Amount, ccy, { decimals: 0 })}
                        </Text>
                      </View>
                      <Text style={[styles.catChange, { color: changeColor }]}>
                        {flat ? "—" : `${up ? "+" : ""}${c.change.toFixed(0)}%`}
                      </Text>
                    </View>
                  );
                })}
              </View>
            )}

            {/* Monthly comparison */}
            <Text style={[styles.sectionTitle, { color: colors.foreground, marginTop: 20 }]}>
              Monthly expenses
            </Text>
            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.totalsHead}>
                <Text style={[styles.monthHeadLabel, { color: colors.mutedForeground }]}>Month</Text>
                <Text style={[styles.totalsHeadYear, { color: colors.mutedForeground }]}>{yearLabel(data.year1)}</Text>
                <Text style={[styles.totalsHeadYear, { color: colors.foreground }]}>{yearLabel(data.year2)}</Text>
              </View>
              {data.monthly.map((m, i) => {
                // Outside the like-for-like window → dimmed (not in the totals).
                const outside = i > lastMonthIdx;
                const cell = (year: number, v: number) =>
                  isFutureMonth(year, i) ? "—" : formatCurrency(v, ccy, { decimals: 0 });
                return (
                  <View
                    key={m.month}
                    style={[
                      styles.monthRow,
                      i === 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
                      outside && { opacity: 0.5 },
                    ]}
                  >
                    <Text style={[styles.monthLabel, { color: colors.foreground }]}>{m.month}</Text>
                    <Text style={[styles.monthVal, { color: colors.mutedForeground }]}>
                      {cell(data.year1, m.year1Expenses)}
                    </Text>
                    <Text style={[styles.monthVal, { color: colors.foreground }]}>
                      {cell(data.year2, m.year2Expenses)}
                    </Text>
                  </View>
                );
              })}
            </View>
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function TotalsRow({
  label,
  v1,
  v2,
  ccy,
  border,
  bold,
}: {
  label: string;
  v1: number;
  v2: number;
  ccy: string;
  border?: boolean;
  bold?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View
      style={[
        styles.totalsRow,
        border && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
      ]}
    >
      <Text style={[styles.totalsLabel, { color: colors.mutedForeground, fontWeight: bold ? "700" : "500" }]}>
        {label}
      </Text>
      <Text style={[styles.totalsVal, { color: colors.mutedForeground, fontWeight: bold ? "700" : "600" }]}>
        {formatCurrency(v1, ccy, { decimals: 0 })}
      </Text>
      <Text style={[styles.totalsVal, { color: colors.foreground, fontWeight: bold ? "800" : "700" }]}>
        {formatCurrency(v2, ccy, { decimals: 0 })}
      </Text>
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
  fieldLabel: { fontSize: 11, fontWeight: "700", letterSpacing: 0.5, marginBottom: 8, marginTop: 6 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 6 },
  chip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden", marginTop: 12 },
  totalsHead: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingTop: 12, paddingBottom: 6 },
  totalsHeadLabel: { flex: 1 },
  totalsHeadYear: { width: 90, textAlign: "right", fontSize: 12, fontWeight: "700", fontVariant: ["tabular-nums"] },
  monthHeadLabel: { flex: 1, fontSize: 12, fontWeight: "700" },
  totalsRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 11 },
  totalsLabel: { flex: 1, fontSize: 14 },
  totalsVal: { width: 90, textAlign: "right", fontSize: 14, fontVariant: ["tabular-nums"] },
  sectionTitle: { fontSize: 16, fontWeight: "700", marginTop: 20 },
  caption: { fontSize: 12, lineHeight: 17, marginTop: 8 },
  catRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 11 },
  catName: { flex: 1, fontSize: 14, fontWeight: "500", marginRight: 8 },
  catAmounts: { flexDirection: "row", alignItems: "center", gap: 4, marginRight: 10 },
  catVal: { fontSize: 12, fontVariant: ["tabular-nums"] },
  catChange: { width: 52, textAlign: "right", fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] },
  monthRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 9 },
  monthLabel: { flex: 1, fontSize: 13, fontWeight: "500" },
  monthVal: { width: 90, textAlign: "right", fontSize: 13, fontVariant: ["tabular-nums"] },
  empty: { fontSize: 14, textAlign: "center", paddingVertical: 24 },
  error: { fontSize: 14, textAlign: "center", paddingVertical: 32 },
});
