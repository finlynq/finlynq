// Portfolio overview (tab root) — hero + investment-returns grid + allocation
// donuts + top movers + tappable holdings list. Reads GET /api/portfolio/overview
// (bare JSON → request() wraps). Names routed through safeName() for cold DEK.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { findHoldingInOverview, holdingDescription } from "../lib/portfolio/holdings";
import { formatQty, signedMoney } from "../lib/portfolio/format";
import type {
  PortfolioOverview,
  PortfolioHoldingSummary,
} from "../../../shared/types";
import type { PortfolioStackParamList } from "../navigation/PortfolioStack";

type Props = NativeStackScreenProps<PortfolioStackParamList, "PortfolioOverview">;

/** Allocation-by-type slices, in donut order (keys of overview.byType). */
const ALLOCATION_TYPE_KEYS = ["etf", "stock", "crypto", "metal", "cash"] as const;

const TYPE_LABELS: Record<string, string> = {
  etf: "ETF",
  stock: "Stock",
  crypto: "Crypto",
  metal: "Metals",
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
  // Once an overview has rendered, focus-driven refetches run in the
  // background: the content (and scroll position) stays put instead of being
  // swapped for a full-screen spinner every time the tab regains focus.
  const hasOverviewRef = useRef(false);

  const fetchOverview = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else if (!hasOverviewRef.current) setLoading(true);
    try {
      const res = await endpoints.getPortfolioOverview();
      if (res.success) {
        hasOverviewRef.current = true;
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

  // Server always sends displayCurrency; USD is the app-wide default (FINLYNQ-183).
  const currency = overview?.displayCurrency ?? "USD";
  const summary = overview?.summary;
  const holdings = overview?.byHolding ?? [];

  const allocData: AllocationSlice[] = useMemo(() => {
    if (!overview) return [];
    if (allocMode === "type") {
      return ALLOCATION_TYPE_KEYS
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
          value: signedMoney(summary.totalUnrealizedGainDisplay, currency),
          tone: tone(summary.totalUnrealizedGainDisplay),
        },
        {
          label: "Realized G/L",
          value: signedMoney(summary.totalRealizedGainDisplay, currency),
          tone: tone(summary.totalRealizedGainDisplay),
        },
        { label: "Dividends", value: formatCurrency(summary.totalDividendsDisplay, currency, { decimals: 0 }) },
        {
          label: "Total return",
          value: signedMoney(summary.totalReturnDisplay, currency),
          tone: tone(summary.totalReturnDisplay),
        },
      ]
    : [];

  const openHolding = (s: PortfolioHoldingSummary) => {
    const members = overview ? findHoldingInOverview(overview, s.key)?.members ?? [] : [];
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
  // Two rows can share a legacy canonical key during a partial securities
  // backfill (one bucketed on security_id, one on the legacy string), so list
  // keys always carry the index too.

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
            {/* A failed background refresh keeps the last overview on screen. */}
            {error ? (
              <Text style={[styles.refreshError, { color: colors.destructive }]}>
                Could not refresh: {error}
              </Text>
            ) : null}
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
                    {signedMoney(gain, currency)} · {pctLabel(summary?.totalUnrealizedGainPct ?? null)}
                  </Text>
                </View>
                <View style={styles.heroStat}>
                  <Text style={[styles.heroStatLabel, { color: colors.mutedForeground }]}>Day change</Text>
                  <Text style={[styles.heroStatValue, { color: day >= 0 ? colors.pos : colors.neg }]}>
                    {signedMoney(day, currency)} · {pctLabel(summary?.dayChangePct ?? null)}
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
                  {movers.map((m, i) => (
                    <GainerLoserRow key={`${m.key}-${i}`} mover={m} currency={currency} />
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
                holdings.map((h, i) => {
                  const g = h.unrealizedGainPct;
                  const gColor = (g ?? 0) > 0 ? colors.pos : (g ?? 0) < 0 ? colors.neg : colors.mutedForeground;
                  // FINLYNQ-242: lead with the company/security description; the
                  // ticker becomes the subtitle. When there's no distinct
                  // description (cash sleeves / metals / custom holdings) the
                  // ticker/name stays the primary line — never blank, never a
                  // doubled code. `ticker` is the canonical symbol (or the
                  // "Cash USD"-style name when there's no symbol).
                  const desc = holdingDescription({ description: h.description, name: h.name, symbol: h.symbol });
                  const ticker = safeName(h.symbol || h.name, "—");
                  const primary = desc ?? ticker;
                  const showSubtitle = desc != null;
                  return (
                    <TouchableOpacity
                      key={`${h.key}-${i}`}
                      style={[styles.holdingRow, { borderBottomColor: colors.border }]}
                      onPress={() => openHolding(h)}
                      activeOpacity={0.7}
                    >
                      <View style={styles.holdingMain}>
                        <Text style={[styles.holdingSym, { color: colors.foreground }]} numberOfLines={1}>
                          {primary}
                        </Text>
                        <Text style={[styles.holdingName, { color: colors.mutedForeground }]} numberOfLines={1}>
                          {showSubtitle
                            ? `${ticker} · ${formatQty(h.totalQty)} units`
                            : `${formatQty(h.totalQty)} units`}
                        </Text>
                      </View>
                      <View style={styles.holdingRight}>
                        <Text style={[styles.holdingAmt, { color: colors.foreground }]}>
                          {formatCurrency(h.marketValueDisplay, currency, { decimals: 0 })}
                        </Text>
                        <Text style={[styles.holdingGain, { color: gColor }]}>
                          {signedMoney(h.unrealizedGainDisplay, currency)}
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
  refreshError: { fontSize: 12, marginBottom: 8 },
  emptyInline: { fontSize: 14, textAlign: "center", paddingVertical: 20 },
});
