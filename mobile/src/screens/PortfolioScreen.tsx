// Portfolio overview (tab root) — hero + investment-returns grid + allocation
// donuts + top movers + tappable holdings list. Reads GET /api/portfolio/overview
// (bare JSON → request() wraps). Names routed through safeName() for cold DEK.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
  TouchableOpacity,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useIsFocused } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { formatCurrency, safeName } from "../lib/format";
import { Icon } from "../components/icon";
import { MetricGrid, type MetricItem } from "../components/portfolio/MetricGrid";
import { AllocationDonut, type AllocationSlice } from "../components/portfolio/AllocationDonut";
import { GainerLoserRow } from "../components/portfolio/GainerLoserRow";
import { canonicalKeyOf } from "../lib/portfolio/holdings";
import type {
  PortfolioOverview,
  PortfolioHoldingSummary,
} from "../../../shared/types";
import type { PortfolioStackParamList } from "../navigation/PortfolioStack";

type Props = NativeStackScreenProps<PortfolioStackParamList, "PortfolioOverview">;

const TYPE_LABELS: Record<string, string> = {
  etf: "ETF",
  stock: "Stock",
  crypto: "Crypto",
  cash: "Cash",
};

function pctLabel(pct: number | null): string {
  if (pct == null) return "";
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

export default function PortfolioScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const isFocused = useIsFocused();
  const [overview, setOverview] = useState<PortfolioOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allocMode, setAllocMode] = useState<"type" | "account">("type");

  const fetchOverview = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const res = await endpoints.getPortfolioOverview();
      if (res.success) {
        setOverview(res.data);
        setError(null);
      } else {
        logger.warn("portfolio", "fetch failed", { error: res.error });
        setError(res.error);
      }
    } catch (e) {
      logger.error("portfolio", "fetch threw", { detail: String(e) });
      setError("Cannot connect to server");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (isFocused) fetchOverview();
  }, [isFocused, fetchOverview]);

  const currency = overview?.displayCurrency ?? "CAD";
  const summary = overview?.summary;
  const holdings = overview?.byHolding ?? [];

  const allocData: AllocationSlice[] = useMemo(() => {
    if (!overview) return [];
    if (allocMode === "type") {
      return ["etf", "stock", "crypto", "cash"]
        .map((k) => ({ label: TYPE_LABELS[k] ?? k, value: overview.byType?.[k]?.value ?? 0 }))
        .filter((s) => s.value > 0);
    }
    return Object.entries(overview.byAccount ?? {})
      .map(([name, b]) => ({ label: safeName(name), value: b.value }))
      .filter((s) => s.value > 0);
  }, [overview, allocMode]);

  const metrics: MetricItem[] = summary
    ? [
        { label: "Market value", value: formatCurrency(summary.totalValueDisplay, currency, { decimals: 0 }) },
        { label: "Cost basis", value: formatCurrency(summary.totalCostBasisDisplay, currency, { decimals: 0 }) },
        {
          label: "Unrealized G/L",
          value: signed(summary.totalUnrealizedGainDisplay, currency),
          tone: tone(summary.totalUnrealizedGainDisplay),
        },
        {
          label: "Realized G/L",
          value: signed(summary.totalRealizedGainDisplay, currency),
          tone: tone(summary.totalRealizedGainDisplay),
        },
        { label: "Dividends", value: formatCurrency(summary.totalDividendsDisplay, currency, { decimals: 0 }) },
        {
          label: "Total return",
          value: signed(summary.totalReturnDisplay, currency),
          tone: tone(summary.totalReturnDisplay),
        },
      ]
    : [];

  const openHolding = (s: PortfolioHoldingSummary) => {
    const members = (overview?.holdings ?? []).filter((h) => canonicalKeyOf(h) === s.key);
    navigation.navigate("HoldingDetail", { summary: s, members, displayCurrency: currency });
  };

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const gain = summary?.totalUnrealizedGainDisplay ?? 0;
  const day = summary?.dayChangeDisplay ?? 0;
  const gainers = overview?.topGainers ?? [];
  const losers = overview?.topLosers ?? [];
  const movers = [...gainers, ...losers];

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={styles.headerRow}>
        <Text style={[styles.header, { color: colors.foreground }]}>Portfolio</Text>
        <TouchableOpacity
          style={[styles.newOpBtn, { borderColor: colors.border }]}
          onPress={() => navigation.navigate("PortfolioOps")}
        >
          <Icon name="add" size={15} color={colors.primary} />
          <Text style={[styles.newOpText, { color: colors.primary }]}>New op</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => fetchOverview(true)} />}
      >
        {error && !overview ? (
          <Text style={[styles.empty, { color: colors.destructive }]}>{error}</Text>
        ) : (
          <>
            {/* Hero */}
            <View style={[styles.hero, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.heroLabel, { color: colors.mutedForeground }]}>Total Value</Text>
              <Text style={[styles.heroValue, { color: colors.foreground }]}>
                {formatCurrency(summary?.totalValueDisplay ?? 0, currency, { decimals: 0 })}
              </Text>
              <View style={styles.heroStatsRow}>
                <View style={styles.heroStat}>
                  <Text style={[styles.heroStatLabel, { color: colors.mutedForeground }]}>Unrealized</Text>
                  <Text style={[styles.heroStatValue, { color: tone(gain) === "pos" ? colors.pos : tone(gain) === "neg" ? colors.neg : colors.foreground }]}>
                    {signed(gain, currency)} · {pctLabel(summary?.totalUnrealizedGainPct ?? null)}
                  </Text>
                </View>
                <View style={styles.heroStat}>
                  <Text style={[styles.heroStatLabel, { color: colors.mutedForeground }]}>Day change</Text>
                  <Text style={[styles.heroStatValue, { color: day >= 0 ? colors.pos : colors.neg }]}>
                    {signed(day, currency)} · {pctLabel(summary?.dayChangePct ?? null)}
                  </Text>
                </View>
              </View>
            </View>

            {/* Investment returns */}
            <Text style={[styles.section, { color: colors.mutedForeground }]}>Investment returns</Text>
            <MetricGrid items={metrics} />

            {/* Reporting chips */}
            <View style={styles.chipRow}>
              <NavChip icon="performance" label="Performance" onPress={() => navigation.navigate("Performance")} />
              <NavChip icon="coins" label="Realized" onPress={() => navigation.navigate("RealizedGains", { displayCurrency: currency })} />
              <NavChip icon="dollar" label="Dividends" onPress={() => navigation.navigate("Dividends", { displayCurrency: currency })} />
            </View>

            {/* Allocation */}
            <Text style={[styles.section, { color: colors.mutedForeground }]}>Allocation</Text>
            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.allocToggle}>
                {(["type", "account"] as const).map((m) => {
                  const active = allocMode === m;
                  return (
                    <TouchableOpacity
                      key={m}
                      onPress={() => setAllocMode(m)}
                      style={[
                        styles.allocChip,
                        { backgroundColor: active ? colors.primary : colors.secondary, borderColor: active ? colors.primary : colors.border },
                      ]}
                    >
                      <Text style={{ color: active ? colors.primaryForeground : colors.foreground, fontSize: 12, fontWeight: "600" }}>
                        By {m}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <AllocationDonut data={allocData} currency={currency} />
            </View>

            {/* Top movers */}
            {movers.length > 0 && (
              <>
                <Text style={[styles.section, { color: colors.mutedForeground }]}>Top movers</Text>
                <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, paddingVertical: 2 }]}>
                  {movers.map((h) => (
                    <GainerLoserRow key={`${h.id}-${h.symbol}`} holding={h} currency={currency} />
                  ))}
                </View>
              </>
            )}

            {/* Holdings */}
            <Text style={[styles.section, { color: colors.mutedForeground }]}>Holdings · {holdings.length}</Text>
            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, paddingHorizontal: 14, paddingVertical: 2 }]}>
              {holdings.length === 0 ? (
                <Text style={[styles.emptyInline, { color: colors.mutedForeground }]}>No holdings yet</Text>
              ) : (
                holdings.map((h) => {
                  const g = h.unrealizedGainPct;
                  const gColor = (g ?? 0) > 0 ? colors.pos : (g ?? 0) < 0 ? colors.neg : colors.mutedForeground;
                  return (
                    <TouchableOpacity
                      key={h.key}
                      style={[styles.holdingRow, { borderBottomColor: colors.border }]}
                      onPress={() => openHolding(h)}
                      activeOpacity={0.7}
                    >
                      <View style={styles.holdingMain}>
                        <Text style={[styles.holdingSym, { color: colors.foreground }]} numberOfLines={1}>
                          {safeName(h.symbol || h.name, "—")}
                        </Text>
                        <Text style={[styles.holdingName, { color: colors.mutedForeground }]} numberOfLines={1}>
                          {safeName(h.name)} · {h.totalQty} units
                        </Text>
                      </View>
                      <View style={styles.holdingRight}>
                        <Text style={[styles.holdingAmt, { color: colors.foreground }]}>
                          {formatCurrency(h.marketValueDisplay, currency, { decimals: 0 })}
                        </Text>
                        <Text style={[styles.holdingGain, { color: gColor }]}>
                          {signed(h.unrealizedGainDisplay, currency)}
                        </Text>
                        <Text style={[styles.holdingPct, { color: gColor }]}>{pctLabel(g)}</Text>
                      </View>
                      <Icon name="chevronRight" size={16} color={colors.mutedForeground} />
                    </TouchableOpacity>
                  );
                })
              )}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function tone(v: number): MetricItem["tone"] {
  return v > 0 ? "pos" : v < 0 ? "neg" : "default";
}
function signed(v: number, currency: string): string {
  return `${v >= 0 ? "+" : ""}${formatCurrency(v, currency, { decimals: 0 })}`;
}

function NavChip({ icon, label, onPress }: { icon: "performance" | "coins" | "dollar"; label: string; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.navChip, { backgroundColor: colors.secondary, borderColor: colors.border }]}
    >
      <Icon name={icon} size={15} color={colors.foreground} />
      <Text style={[styles.navChipText, { color: colors.foreground }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  header: { fontSize: 28, fontWeight: "800" },
  newOpBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  newOpText: { fontSize: 14, fontWeight: "700" },
  scroll: { paddingHorizontal: 16, paddingBottom: 32 },
  hero: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 16, marginBottom: 12 },
  heroLabel: { fontSize: 13, fontWeight: "600", marginBottom: 4 },
  heroValue: { fontSize: 30, fontWeight: "800", fontVariant: ["tabular-nums"] },
  heroStatsRow: { flexDirection: "row", gap: 16, marginTop: 12 },
  heroStat: { flex: 1 },
  heroStatLabel: { fontSize: 12, marginBottom: 2 },
  heroStatValue: { fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] },
  section: { fontSize: 12, fontWeight: "700", textTransform: "uppercase", marginBottom: 8, marginTop: 4 },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 14, marginBottom: 12 },
  chipRow: { flexDirection: "row", gap: 8, marginBottom: 12 },
  navChip: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  navChipText: { fontSize: 13, fontWeight: "600" },
  allocToggle: { flexDirection: "row", gap: 8, marginBottom: 12 },
  allocChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  holdingRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  holdingMain: { flex: 1, marginRight: 10 },
  holdingSym: { fontSize: 15, fontWeight: "700" },
  holdingName: { fontSize: 12, marginTop: 2 },
  holdingRight: { alignItems: "flex-end", marginRight: 6 },
  holdingAmt: { fontSize: 15, fontWeight: "700", fontVariant: ["tabular-nums"] },
  holdingGain: { fontSize: 12, fontWeight: "600", marginTop: 2, fontVariant: ["tabular-nums"] },
  holdingPct: { fontSize: 12, fontWeight: "600", marginTop: 1, fontVariant: ["tabular-nums"] },
  empty: { fontSize: 14, textAlign: "center", paddingVertical: 32 },
  emptyInline: { fontSize: 14, textAlign: "center", paddingVertical: 20 },
});
