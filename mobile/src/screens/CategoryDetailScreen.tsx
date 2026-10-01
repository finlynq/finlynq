// One category over time — mirrors the web /categories/[id] page
// (GET /api/reports/category). Monthly bars with the average (dashed) and
// budget (amber dots), comparisons, top payees and recent transactions.
// Tap a bar to see that month's numbers.
import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Dimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import Svg, { Rect, Line, Circle } from "react-native-svg";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { formatCurrency, formatShortDate, safeName } from "../lib/format";
import { Icon } from "../components/icon";
import {
  CATEGORY_PALETTE,
  CATEGORY_WINDOWS,
  changeIsGood,
  changeLabel,
  monthLabel,
  sharePct,
} from "../lib/reports/categories";
import type { CategoryDetailMonth, CategoryDetailResponse } from "../../../shared/types";
import type { MoreStackParamList } from "../navigation/MoreStack";

const CHART_H = 170;
const PAD_TOP = 10;
const PAD_BOTTOM = 6;
const BUDGET_COLOR = CATEGORY_PALETTE[1];

function MonthlyBars({
  months,
  average,
  barColor,
  width,
  selected,
  onSelect,
}: {
  months: CategoryDetailMonth[];
  average: number | null;
  barColor: string;
  width: number;
  selected: number;
  onSelect: (i: number) => void;
}) {
  const { colors } = useTheme();
  const n = Math.max(1, months.length);
  const slot = width / n;
  const barW = Math.max(4, Math.min(28, slot * 0.62));
  const maxVal = Math.max(1, average ?? 0, ...months.map((m) => Math.max(m.amount, m.budget ?? 0)));
  const usable = CHART_H - PAD_TOP - PAD_BOTTOM;
  const y = (v: number) => CHART_H - PAD_BOTTOM - (Math.max(0, v) / maxVal) * usable;
  const labelEvery = Math.max(1, Math.ceil(n / 6));

  return (
    <View>
      <Svg width={width} height={CHART_H}>
        <Line x1={0} y1={CHART_H - PAD_BOTTOM} x2={width} y2={CHART_H - PAD_BOTTOM} stroke={colors.border} strokeWidth={1} />
        {months.map((m, i) => {
          const x = i * slot + (slot - barW) / 2;
          const top = y(m.amount);
          return (
            <React.Fragment key={m.month}>
              {/* Full-height transparent hit area so small bars are easy to tap. */}
              <Rect x={i * slot} y={0} width={slot} height={CHART_H} fill="transparent" onPress={() => onSelect(i)} />
              <Rect
                x={x}
                y={top}
                width={barW}
                height={Math.max(1, CHART_H - PAD_BOTTOM - top)}
                rx={3}
                fill={barColor}
                opacity={i === selected ? 1 : m.partial ? 0.4 : 0.7}
                onPress={() => onSelect(i)}
              />
              {m.budget != null && <Circle cx={x + barW / 2} cy={y(m.budget)} r={3.5} fill={BUDGET_COLOR} />}
            </React.Fragment>
          );
        })}
        {average != null && (
          <Line x1={0} y1={y(average)} x2={width} y2={y(average)} stroke={colors.mutedForeground} strokeWidth={1} strokeDasharray="4 4" />
        )}
      </Svg>
      <View style={[styles.axis, { width }]}>
        {months.map((m, i) => (
          <Text key={m.month} style={[styles.axisLabel, { width: slot, color: colors.mutedForeground }]} numberOfLines={1}>
            {i % labelEvery === 0 || i === n - 1 ? monthLabel(m.month, "short") : ""}
          </Text>
        ))}
      </View>
    </View>
  );
}

export default function CategoryDetailScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation<{ goBack: () => void }>();
  const route = useRoute<RouteProp<MoreStackParamList, "CategoryDetail">>();
  const { categoryId } = route.params;
  // Same width source as the other report charts (TrendBars).
  const screenW = Dimensions.get("window").width;

  const [months, setMonths] = useState<number>(12);
  const [data, setData] = useState<CategoryDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(-1);

  const load = useCallback(async () => {
    try {
      const res = await endpoints.getCategoryDetail(categoryId, months);
      if (res.success && res.data) {
        setData(res.data);
        setError(null);
        // Default to the last COMPLETE month (the current one is still running).
        setSelected(Math.max(0, res.data.months.length - 2));
      } else {
        const err = res.success ? "Empty response" : res.error;
        logger.warn("category-detail", "fetch failed", { error: err, categoryId });
        setError(/HTTP 404/i.test(err) ? "Category reports need a newer Finlynq server." : err);
      }
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error("category-detail", "fetch threw", { detail });
      setError("Cannot connect to server");
    }
  }, [categoryId, months]);

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

  const onRefresh = () => {
    setRefreshing(true);
    load().finally(() => setRefreshing(false));
  };

  const title = safeName(data?.category.name ?? route.params.name, "Category");
  const isIncome = data?.category.type === "I";
  const noun = isIncome ? "income" : "spending";
  const cur = data?.displayCurrency ?? "USD";
  const barColor = isIncome ? colors.pos : colors.neg;
  const s = data?.stats;
  const lastVsAvg = s && s.averageMonthly ? (s.lastMonth - s.averageMonthly) / s.averageMonthly : null;
  const good = changeIsGood(lastVsAvg, isIncome);
  const sel = data && selected >= 0 ? data.months[selected] : null;
  const current = data?.months[data.months.length - 1];
  const chartW = screenW - 32 - 28;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={10} style={styles.backBtn} accessibilityLabel="Back">
          <Icon name="back" size={20} color={colors.primary} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={[styles.header, { color: colors.foreground }]} numberOfLines={1}>{title}</Text>
          {data && (
            <Text style={[styles.sub, { color: colors.mutedForeground }]}>
              {isIncome ? "Income" : "Expense"}
              {data.category.group ? ` · ${data.category.group}` : ""}
            </Text>
          )}
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        <View style={[styles.segment, { backgroundColor: colors.secondary }]}>
          {CATEGORY_WINDOWS.map((m) => (
            <TouchableOpacity
              key={m}
              onPress={() => setMonths(m)}
              style={[styles.segmentBtn, months === m && { backgroundColor: colors.card }]}
              accessibilityState={{ selected: months === m }}
            >
              <Text style={[styles.segmentText, { color: months === m ? colors.foreground : colors.mutedForeground }]}>
                {m} months
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {loading ? (
          <ActivityIndicator style={{ marginTop: 40 }} size="large" color={colors.primary} />
        ) : error ? (
          <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text>
        ) : data && s ? (
          <>
            <View style={styles.tiles}>
              <Tile
                label="This month so far"
                value={formatCurrency(s.thisMonth, cur)}
                sub={current?.budget != null ? `of ${formatCurrency(current.budget, cur, { decimals: 0 })} budget` : `${current?.count ?? 0} transactions`}
              />
              <Tile
                label="Last month"
                value={formatCurrency(s.lastMonth, cur)}
                sub={changeLabel(lastVsAvg) ? `${changeLabel(lastVsAvg)} vs average` : undefined}
                subColor={good == null ? undefined : good ? colors.pos : colors.neg}
              />
              <Tile
                label="Monthly average"
                value={s.averageMonthly != null ? formatCurrency(s.averageMonthly, cur) : "—"}
                sub={s.medianMonthly != null ? `median ${formatCurrency(s.medianMonthly, cur, { decimals: 0 })}` : "needs a full month"}
              />
              <Tile
                label="Same month last year"
                value={formatCurrency(s.sameMonthLastYear, cur)}
                sub={`share of ${noun}: ${sharePct(s.shareOfType)}`}
              />
            </View>

            {s.transactionCount === 0 ? (
              <Text style={[styles.empty, { color: colors.mutedForeground }]}>
                No transactions in this category in the last {months} months.
              </Text>
            ) : (
              <>
                {/* Chart */}
                <View style={[styles.card, styles.pad, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <Text style={[styles.cardTitle, { color: colors.foreground }]}>Monthly {noun}</Text>
                  {sel ? (
                    <Text style={[styles.selLine, { color: colors.foreground }]}>
                      {monthLabel(sel.month)}{sel.partial ? " (so far)" : ""}: {formatCurrency(sel.amount, cur)}
                      <Text style={{ color: colors.mutedForeground }}>
                        {` · ${sel.count} transaction${sel.count === 1 ? "" : "s"}`}
                        {sel.budget != null ? ` · budget ${formatCurrency(sel.budget, cur, { decimals: 0 })}` : ""}
                      </Text>
                    </Text>
                  ) : null}
                  <MonthlyBars
                    months={data.months}
                    average={s.averageMonthly}
                    barColor={barColor}
                    width={chartW}
                    selected={selected}
                    onSelect={setSelected}
                  />
                  <View style={styles.legendRow}>
                    <View style={styles.legendItem}>
                      <View style={[styles.legendDash, { borderColor: colors.mutedForeground }]} />
                      <Text style={[styles.legendText, { color: colors.mutedForeground }]}>
                        Average{s.averageMonthly != null ? ` ${formatCurrency(s.averageMonthly, cur, { decimals: 0 })}` : ""}
                      </Text>
                    </View>
                    {data.hasBudget && (
                      <View style={styles.legendItem}>
                        <View style={[styles.legendDot, { backgroundColor: BUDGET_COLOR }]} />
                        <Text style={[styles.legendText, { color: colors.mutedForeground }]}>Budget</Text>
                      </View>
                    )}
                  </View>
                </View>

                {/* Top payees */}
                <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>TOP PAYEES</Text>
                <View style={[styles.card, styles.pad, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  {data.payeesLocked ? (
                    <Text style={[styles.empty, { color: colors.mutedForeground }]}>Unlock your data to see payees.</Text>
                  ) : data.topPayees.length === 0 ? (
                    <Text style={[styles.empty, { color: colors.mutedForeground }]}>No payees recorded.</Text>
                  ) : (
                    data.topPayees.map((p) => (
                      <View key={p.payee} style={styles.payee}>
                        <View style={styles.payeeLine}>
                          <Text style={[styles.payeeName, { color: colors.foreground }]} numberOfLines={1}>{p.payee}</Text>
                          <Text style={[styles.amount, { color: colors.foreground }]}>
                            {formatCurrency(p.amount, cur)}
                            <Text style={[styles.count, { color: colors.mutedForeground }]}> · {p.count}×</Text>
                          </Text>
                        </View>
                        <View style={[styles.payeeTrack, { backgroundColor: colors.secondary }]}>
                          <View style={{ width: `${Math.max(2, Math.min(100, p.share * 100))}%`, height: "100%", backgroundColor: barColor, borderRadius: 3, opacity: 0.85 }} />
                        </View>
                      </View>
                    ))
                  )}
                </View>

                {/* Recent */}
                <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
                  RECENT ({s.transactionCount} IN {months} MONTHS)
                </Text>
                <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  {data.recent.map((t, i) => (
                    <View
                      key={t.id}
                      style={[styles.txRow, i < data.recent.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }]}
                    >
                      <View style={{ flex: 1, marginRight: 8 }}>
                        <Text style={[styles.payeeName, { color: colors.foreground }]} numberOfLines={1}>{t.payee || "(no payee)"}</Text>
                        <Text style={[styles.count, { color: colors.mutedForeground }]} numberOfLines={1}>
                          {formatShortDate(t.date)}{t.accountName ? ` · ${t.accountName}` : ""}
                        </Text>
                      </View>
                      <Text style={[styles.amount, { color: t.amount < 0 ? colors.neg : colors.pos }]}>{formatCurrency(t.amount, t.currency)}</Text>
                    </View>
                  ))}
                </View>
                <Text style={[styles.hint, { color: colors.mutedForeground }]}>
                  {months} months: {formatCurrency(s.total, cur)} in total
                  {s.averageTransaction != null ? ` · ${formatCurrency(s.averageTransaction, cur)} per transaction` : ""}. Amounts in {cur}.
                </Text>
              </>
            )}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Tile({ label, value, sub, subColor }: { label: string; value: string; sub?: string; subColor?: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.tile, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.tileLabel, { color: colors.mutedForeground }]} numberOfLines={1}>{label}</Text>
      <Text style={[styles.tileValue, { color: colors.foreground }]} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
      {sub ? <Text style={[styles.tileSub, { color: subColor ?? colors.mutedForeground }]} numberOfLines={1}>{sub}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  headerRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  backBtn: { marginRight: 10 },
  header: { fontSize: 24, fontWeight: "800" },
  sub: { fontSize: 13, marginTop: 1 },
  scroll: { paddingHorizontal: 16, paddingBottom: 40 },
  segment: { flexDirection: "row", borderRadius: 10, padding: 3, marginBottom: 12 },
  segmentBtn: { flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: 8 },
  segmentText: { fontSize: 13, fontWeight: "700" },
  tiles: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between" },
  tile: { width: "48.5%", borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 8 },
  tileLabel: { fontSize: 12, fontWeight: "600" },
  tileValue: { fontSize: 18, fontWeight: "800", marginTop: 2, fontVariant: ["tabular-nums"] },
  tileSub: { fontSize: 11, marginTop: 1 },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, marginBottom: 10, overflow: "hidden" },
  pad: { padding: 14 },
  cardTitle: { fontSize: 15, fontWeight: "700" },
  selLine: { fontSize: 13, fontWeight: "600", marginTop: 4, marginBottom: 6 },
  axis: { flexDirection: "row", marginTop: 4 },
  axisLabel: { fontSize: 10, textAlign: "center" },
  legendRow: { flexDirection: "row", justifyContent: "center", marginTop: 8 },
  legendItem: { flexDirection: "row", alignItems: "center", marginHorizontal: 8 },
  legendDash: { width: 16, borderTopWidth: 1, borderStyle: "dashed", marginRight: 5 },
  legendDot: { width: 8, height: 8, borderRadius: 4, marginRight: 5 },
  legendText: { fontSize: 11 },
  sectionTitle: { fontSize: 12, fontWeight: "700", letterSpacing: 0.5, marginTop: 6, marginBottom: 8 },
  payee: { marginBottom: 12 },
  payeeLine: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  payeeName: { fontSize: 14, fontWeight: "600", flexShrink: 1, marginRight: 8 },
  payeeTrack: { height: 6, borderRadius: 3, marginTop: 5, overflow: "hidden" },
  amount: { fontSize: 14, fontWeight: "700", fontVariant: ["tabular-nums"] },
  count: { fontSize: 12, fontWeight: "500" },
  txRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 11 },
  empty: { fontSize: 13, textAlign: "center", paddingVertical: 12 },
  hint: { fontSize: 12, textAlign: "center", marginTop: 4, lineHeight: 17, paddingHorizontal: 8 },
  error: { textAlign: "center", marginTop: 32, fontSize: 14, paddingHorizontal: 12, lineHeight: 20 },
});
