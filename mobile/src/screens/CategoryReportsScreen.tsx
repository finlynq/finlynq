// Categories — where the money went in a month, category by category, and how
// each compares with its usual month. Mirrors the web /categories page
// (GET /api/reports/categories). Tap a category for its detail screen.
import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import Svg, { Polyline } from "react-native-svg";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { formatCurrency, safeName } from "../lib/format";
import { Icon } from "../components/icon";
import {
  CATEGORY_PALETTE,
  OTHER_COLOR,
  changeIsGood,
  changeLabel,
  currentMonthKey,
  monthLabel,
  sharePct,
  shiftMonth,
} from "../lib/reports/categories";
import type { CategoryOverviewResponse } from "../../../shared/types";
import type { MoreStackParamList } from "../navigation/MoreStack";

type Nav = NativeStackNavigationProp<MoreStackParamList, "CategoryReports">;

const TOP_SEGMENTS = 6;

/** Tiny trend line for a category row. */
function MiniTrend({ values, color }: { values: number[]; color: string }) {
  const w = 52;
  const h = 22;
  if (values.length < 2) return <View style={{ width: w, height: h }} />;
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => `${((i / (values.length - 1)) * (w - 2) + 1).toFixed(1)},${(h - 1 - ((v - min) / span) * (h - 2)).toFixed(1)}`)
    .join(" ");
  return (
    <Svg width={w} height={h}>
      <Polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </Svg>
  );
}

export default function CategoryReportsScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation<Nav>();
  const route = useRoute<RouteProp<MoreStackParamList, "CategoryReports">>();
  const thisMonth = currentMonthKey();

  const [type, setType] = useState<"E" | "I">(route.params?.type ?? "E");
  const [month, setMonth] = useState(thisMonth);
  const [data, setData] = useState<CategoryOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await endpoints.getCategoryOverview({ month, type, months: 12 });
      if (res.success && res.data) {
        setData(res.data);
        setError(null);
      } else {
        const err = res.success ? "Empty response" : res.error;
        logger.warn("category-reports", "fetch failed", { error: err });
        setError(
          /not found|HTTP 404/i.test(err)
            ? "Category reports need a newer Finlynq server. Update your server, or use the web app."
            : err,
        );
      }
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error("category-reports", "fetch threw", { detail });
      setError("Cannot connect to server");
    }
  }, [month, type]);

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

  const isIncome = type === "I";
  const noun = isIncome ? "income" : "spending";
  const cur = data?.displayCurrency ?? "USD";
  const active = (data?.categories ?? []).filter((c) => c.amount > 0);
  const segments = active.slice(0, TOP_SEGMENTS);
  const otherAmount = active.slice(TOP_SEGMENTS).reduce((s, c) => s + c.amount, 0);
  const totalChange = data?.averageTotal ? (data.total - data.averageTotal) / data.averageTotal : null;
  const toneColor = (change: number | null | undefined) => {
    const good = changeIsGood(change, isIncome);
    return good == null ? colors.mutedForeground : good ? colors.pos : colors.neg;
  };
  const colorFor = (id: number) => {
    const i = segments.findIndex((s) => s.id === id);
    return i >= 0 ? CATEGORY_PALETTE[i] : OTHER_COLOR;
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={10} style={styles.backBtn} accessibilityLabel="Back">
          <Icon name="back" size={20} color={colors.primary} />
        </TouchableOpacity>
        <Text style={[styles.header, { color: colors.foreground }]}>Categories</Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {/* Controls */}
        <View style={[styles.segment, { backgroundColor: colors.secondary }]}>
          {(["E", "I"] as const).map((t) => (
            <TouchableOpacity
              key={t}
              onPress={() => setType(t)}
              style={[styles.segmentBtn, type === t && { backgroundColor: colors.card }]}
              accessibilityState={{ selected: type === t }}
            >
              <Text style={[styles.segmentText, { color: type === t ? colors.foreground : colors.mutedForeground }]}>
                {t === "E" ? "Spending" : "Income"}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <View style={styles.monthRow}>
          <TouchableOpacity onPress={() => setMonth(shiftMonth(month, -1))} hitSlop={10} accessibilityLabel="Previous month">
            <Icon name="back" size={20} color={colors.foreground} />
          </TouchableOpacity>
          <Text style={[styles.monthText, { color: colors.foreground }]}>{monthLabel(month)}</Text>
          <TouchableOpacity
            onPress={() => setMonth(shiftMonth(month, 1))}
            disabled={month >= thisMonth}
            hitSlop={10}
            accessibilityLabel="Next month"
            style={{ opacity: month >= thisMonth ? 0.3 : 1 }}
          >
            <Icon name="chevronRight" size={20} color={colors.foreground} />
          </TouchableOpacity>
        </View>

        {loading ? (
          <ActivityIndicator style={{ marginTop: 40 }} size="large" color={colors.primary} />
        ) : error ? (
          <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text>
        ) : data ? (
          <>
            {/* Summary */}
            <View style={[styles.card, styles.pad, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.muted, { color: colors.mutedForeground }]}>
                {isIncome ? "Income" : "Spending"} in {monthLabel(data.month)}
                {data.partial ? " so far" : ""}
              </Text>
              <Text style={[styles.total, { color: colors.foreground }]}>{formatCurrency(data.total, cur)}</Text>
              {data.averageTotal != null && (
                <Text style={[styles.muted, { color: colors.mutedForeground }]}>
                  Usual month {formatCurrency(data.averageTotal, cur, { decimals: 0 })}
                  {changeLabel(totalChange) ? (
                    <Text style={{ color: toneColor(totalChange), fontWeight: "700" }}>  {changeLabel(totalChange)}</Text>
                  ) : null}
                </Text>
              )}
              {active.length > 0 ? (
                <>
                  <View style={[styles.stack, { backgroundColor: colors.secondary }]}>
                    {segments.map((c, i) => (
                      <View key={c.id} style={{ flex: c.amount, backgroundColor: CATEGORY_PALETTE[i] }} />
                    ))}
                    {otherAmount > 0 && <View style={{ flex: otherAmount, backgroundColor: OTHER_COLOR }} />}
                  </View>
                  <View style={styles.legend}>
                    {segments.map((c, i) => (
                      <View key={c.id} style={styles.legendItem}>
                        <View style={[styles.legendDot, { backgroundColor: CATEGORY_PALETTE[i] }]} />
                        <Text style={[styles.legendText, { color: colors.mutedForeground }]} numberOfLines={1}>
                          {safeName(c.name, "Category")} {sharePct(c.share)}
                        </Text>
                      </View>
                    ))}
                    {otherAmount > 0 && data.total > 0 && (
                      <View style={styles.legendItem}>
                        <View style={[styles.legendDot, { backgroundColor: OTHER_COLOR }]} />
                        <Text style={[styles.legendText, { color: colors.mutedForeground }]}>
                          Other {sharePct(otherAmount / data.total)}
                        </Text>
                      </View>
                    )}
                  </View>
                </>
              ) : (
                <Text style={[styles.muted, styles.emptyNote, { color: colors.mutedForeground }]}>
                  No {noun} recorded in {monthLabel(data.month)} yet.
                </Text>
              )}
            </View>

            {/* Category list */}
            <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>BY CATEGORY</Text>
            {data.categories.length === 0 ? (
              <Text style={[styles.muted, styles.emptyNote, { color: colors.mutedForeground }]}>
                No categories with {noun} in the last 12 months.
              </Text>
            ) : (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                {data.categories.map((c, idx) => {
                  const color = colorFor(c.id);
                  const ch = changeLabel(c.change);
                  return (
                    <TouchableOpacity
                      key={c.id}
                      activeOpacity={0.7}
                      onPress={() => navigation.navigate("CategoryDetail", { categoryId: c.id, name: c.name ?? undefined })}
                      style={[
                        styles.row,
                        idx < data.categories.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
                      ]}
                    >
                      <View style={[styles.dot, { backgroundColor: color }]} />
                      <View style={styles.rowMain}>
                        <Text style={[styles.rowName, { color: colors.foreground }]} numberOfLines={1}>
                          {safeName(c.name, "Category")}
                        </Text>
                        <Text style={[styles.rowSub, { color: colors.mutedForeground }]} numberOfLines={1}>
                          {c.average != null ? `usually ${formatCurrency(c.average, cur, { decimals: 0 })}` : "new this period"}
                          {c.budget != null ? ` · budget ${formatCurrency(c.budget, cur, { decimals: 0 })}` : ""}
                        </Text>
                        <View style={[styles.shareTrack, { backgroundColor: colors.secondary }]}>
                          <View style={{ width: `${Math.min(100, c.share * 100)}%`, height: "100%", backgroundColor: color, borderRadius: 2 }} />
                        </View>
                      </View>
                      <MiniTrend values={c.trend} color={isIncome ? colors.pos : colors.neg} />
                      <View style={styles.rowRight}>
                        <Text style={[styles.amount, { color: colors.foreground }]}>{formatCurrency(c.amount, cur, { decimals: 0 })}</Text>
                        {ch ? <Text style={[styles.change, { color: toneColor(c.change) }]}>{ch}</Text> : null}
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
            <Text style={[styles.hint, { color: colors.mutedForeground }]}>
              Compared with each category's average over the previous complete months. Amounts in {cur}.
            </Text>
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  headerRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  backBtn: { marginRight: 8 },
  header: { fontSize: 26, fontWeight: "800" },
  scroll: { paddingHorizontal: 16, paddingBottom: 40 },
  segment: { flexDirection: "row", borderRadius: 10, padding: 3, marginBottom: 10 },
  segmentBtn: { flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: 8 },
  segmentText: { fontSize: 14, fontWeight: "700" },
  monthRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 4, marginBottom: 12 },
  monthText: { fontSize: 16, fontWeight: "700" },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, marginBottom: 10, overflow: "hidden" },
  pad: { padding: 14 },
  muted: { fontSize: 13 },
  total: { fontSize: 30, fontWeight: "800", marginVertical: 2, fontVariant: ["tabular-nums"] },
  stack: { flexDirection: "row", height: 12, borderRadius: 6, overflow: "hidden", marginTop: 12 },
  legend: { flexDirection: "row", flexWrap: "wrap", marginTop: 10 },
  legendItem: { flexDirection: "row", alignItems: "center", marginRight: 12, marginBottom: 6, maxWidth: "48%" },
  legendDot: { width: 9, height: 9, borderRadius: 2, marginRight: 5 },
  legendText: { fontSize: 12 },
  emptyNote: { marginTop: 8 },
  sectionTitle: { fontSize: 12, fontWeight: "700", letterSpacing: 0.5, marginTop: 8, marginBottom: 8 },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 12 },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 10 },
  rowMain: { flex: 1, marginRight: 8 },
  rowName: { fontSize: 15, fontWeight: "600" },
  rowSub: { fontSize: 12, marginTop: 1 },
  shareTrack: { height: 4, borderRadius: 2, marginTop: 6, overflow: "hidden" },
  rowRight: { alignItems: "flex-end", marginLeft: 8, minWidth: 68 },
  amount: { fontSize: 14, fontWeight: "700", fontVariant: ["tabular-nums"] },
  change: { fontSize: 12, fontWeight: "700", marginTop: 2 },
  hint: { fontSize: 12, textAlign: "center", marginTop: 6, lineHeight: 17, paddingHorizontal: 8 },
  error: { textAlign: "center", marginTop: 32, fontSize: 14, paddingHorizontal: 12, lineHeight: 20 },
});
