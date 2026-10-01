// Realized gains — tax-year + term (short/long/all) filters + a "Show in
// {currency}" toggle. Reads GET /api/portfolio/realized-gains (enveloped). Each
// row is one lot closure.
//
// Mirrors the web report (FINLYNQ-183): the native view keeps every closure in
// its own currency, so its total is shown PER CURRENCY from `totals.byCurrency`
// (never one mixed-currency sum, FINLYNQ-123); the unified view (`?unified=1`)
// converts each closure into the user's display currency at historical FX and
// shows a single `totalRealizedGainInBase`.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  Switch,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { formatCurrency, safeName, formatShortDate } from "../lib/format";
import { currencyTotals, formatPerShare, formatQty, signedMoney } from "../lib/portfolio/format";
import { Icon } from "../components/icon";
import type { RealizedGainsResult, RealizedGainRow } from "../../../shared/types";
import type { PortfolioStackParamList } from "../navigation/PortfolioStack";

type Props = NativeStackScreenProps<PortfolioStackParamList, "RealizedGains">;
type Term = "all" | "short" | "long";

function recentYears(): number[] {
  const y = new Date().getFullYear();
  return [y, y - 1, y - 2, y - 3];
}

export default function RealizedGainsScreen({ navigation, route }: Props) {
  const { colors } = useTheme();
  const [year, setYear] = useState<number | null>(recentYears()[0]);
  const [term, setTerm] = useState<Term>("all");
  const [unified, setUnified] = useState(false);
  const [data, setData] = useState<RealizedGainsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const years = useMemo(recentYears, []);

  const load = useCallback(
    async (f: { year: number | null; term: Term; unified: boolean }, isRefresh: boolean) => {
      const seq = ++seqRef.current;
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      const params = new URLSearchParams();
      if (f.year != null) params.set("taxYear", String(f.year));
      params.set("term", f.term);
      if (f.unified) params.set("unified", "1");
      try {
        const res = await endpoints.getRealizedGains(params.toString());
        if (seq !== seqRef.current) return;
        if (res.success) {
          setData(res.data);
          setError(null);
        } else {
          logger.warn("realized-gains", "fetch failed", { error: res.error });
          setError(res.error);
        }
      } catch (e) {
        if (seq !== seqRef.current) return;
        logger.error("realized-gains", "fetch threw", { detail: String(e) });
        setError("Cannot connect to server");
      } finally {
        if (isRefresh) setRefreshing(false);
        if (seq === seqRef.current) setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    void load({ year, term, unified }, false);
  }, [year, term, unified, load]);

  const rows = data?.rows ?? [];
  // The unified currency is the user's display currency; the server stamps it
  // on each unified row's `baseCurrency`. USD is the app-wide default.
  const unifiedCurrency =
    rows.find((r) => r.baseCurrency)?.baseCurrency ?? route.params?.displayCurrency ?? "USD";
  const showUnified = unified && data?.totalRealizedGainInBase != null;
  const nativeTotals = currencyTotals(data?.totals.byCurrency, (v) => v.realizedGain);
  const holdingsCount = new Set(rows.map((r) => r.holdingId)).size;
  const toneColor = (v: number) => (v > 0 ? colors.pos : v < 0 ? colors.neg : colors.foreground);

  // Unified rows carry realizedGainInBase in the display currency; otherwise
  // (native view, or a row the server couldn't convert) use the native gain.
  const rowGain = (r: RealizedGainRow): { value: number; currency: string } =>
    unified && r.realizedGainInBase != null
      ? { value: r.realizedGainInBase, currency: r.baseCurrency ?? unifiedCurrency }
      : { value: r.realizedGain, currency: r.currency };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
          <Icon name="back" size={20} color={colors.primary} />
          <Text style={[styles.backText, { color: colors.primary }]}>Portfolio</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.foreground }]}>Realized gains</Text>
        <View style={{ width: 70 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void load({ year, term, unified }, true)} />
        }
      >
        {/* Year chips */}
        <View style={styles.chipRow}>
          <Chip label="All years" active={year == null} onPress={() => setYear(null)} />
          {years.map((y) => (
            <Chip key={y} label={String(y)} active={year === y} onPress={() => setYear(y)} />
          ))}
        </View>
        {/* Term chips */}
        <View style={styles.chipRow}>
          {(["all", "short", "long"] as Term[]).map((t) => (
            <Chip
              key={t}
              label={t === "all" ? "All" : t === "short" ? "Short" : "Long"}
              active={term === t}
              onPress={() => setTerm(t)}
            />
          ))}
        </View>
        {/* Unified display-currency toggle (FINLYNQ-183 wording) */}
        <View style={[styles.toggleRow, { borderBottomColor: colors.border }]}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.toggleTitle, { color: colors.foreground }]}>Show in {unifiedCurrency}</Text>
            <Text style={[styles.toggleSub, { color: colors.mutedForeground }]}>
              Converts each closure at historical FX rates
            </Text>
          </View>
          <Switch
            value={unified}
            onValueChange={setUnified}
            trackColor={{ true: colors.primary, false: colors.border }}
          />
        </View>

        {loading ? (
          <ActivityIndicator style={{ marginTop: 32 }} size="large" color={colors.primary} />
        ) : error ? (
          <Text style={[styles.empty, { color: colors.destructive }]}>{error}</Text>
        ) : (
          <>
            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.cardLabel, { color: colors.mutedForeground }]}>
                Total realized {year != null ? `(${year})` : "(all years)"}
              </Text>
              {showUnified ? (
                <Text style={[styles.cardValue, { color: toneColor(data!.totalRealizedGainInBase!) }]}>
                  {signedMoney(data!.totalRealizedGainInBase!, unifiedCurrency)}
                </Text>
              ) : nativeTotals.length === 0 ? (
                <Text style={[styles.cardValue, { color: colors.foreground }]}>
                  {formatCurrency(0, unifiedCurrency, { decimals: 0 })}
                </Text>
              ) : (
                // Native view: one total per currency — never summed across them.
                nativeTotals.map((t) => (
                  <Text
                    key={t.currency}
                    style={[
                      nativeTotals.length === 1 ? styles.cardValue : styles.cardValueMulti,
                      { color: toneColor(t.amount) },
                    ]}
                  >
                    {signedMoney(t.amount, t.currency)}
                    {nativeTotals.length > 1 ? ` ${t.currency}` : ""}
                  </Text>
                ))
              )}
              <Text style={[styles.cardHint, { color: colors.mutedForeground }]}>
                {rows.length} closure{rows.length === 1 ? "" : "s"} · {holdingsCount} holding
                {holdingsCount === 1 ? "" : "s"}
              </Text>
            </View>

            {rows.length === 0 ? (
              <Text style={[styles.empty, { color: colors.mutedForeground }]}>
                No realized gains in this range.
              </Text>
            ) : (
              rows.map((r) => {
                const g = rowGain(r);
                return (
                  <View
                    key={r.closureId}
                    style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border }]}
                  >
                    <View style={styles.rowTop}>
                      <Text style={[styles.rowSym, { color: colors.foreground }]} numberOfLines={1}>
                        {safeName(r.holdingName, "Holding")}
                      </Text>
                      <Text style={[styles.rowGain, { color: g.value >= 0 ? colors.pos : colors.neg }]}>
                        {signedMoney(g.value, g.currency, 2)}
                      </Text>
                    </View>
                    <Text style={[styles.rowMeta, { color: colors.mutedForeground }]} numberOfLines={1}>
                      {formatShortDate(r.closeDate)} · {formatQty(r.qtyClosed)}u ·{" "}
                      {formatPerShare(r.costPerShare, r.currency)} →{" "}
                      {formatPerShare(r.proceedsPerShare, r.currency)}
                    </Text>
                    <View style={styles.badges}>
                      <Badge
                        label={`${r.term === "short" ? "Short" : "Long"} · ${r.daysHeld}d`}
                        bg={colors.secondary}
                        fg={colors.mutedForeground}
                      />
                      {/* Short-position closure; distinct from the short/long-TERM badge. */}
                      {r.closeKind.startsWith("short") && (
                        <Badge label="Short sale" bg={colors.neg + "22"} fg={colors.neg} />
                      )}
                      {unified && r.fxSnapshotMissing && (
                        <Badge label="Approx. FX" bg={colors.secondary} fg={colors.mutedForeground} />
                      )}
                    </View>
                  </View>
                );
              })
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[
        styles.chip,
        {
          backgroundColor: active ? colors.primary : colors.secondary,
          borderColor: active ? colors.primary : colors.border,
        },
      ]}
    >
      <Text style={{ color: active ? colors.primaryForeground : colors.foreground, fontSize: 13, fontWeight: "600" }}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function Badge({ label, bg, fg }: { label: string; bg: string; fg: string }) {
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={{ color: fg, fontSize: 11, fontWeight: "600" }}>{label}</Text>
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
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    marginBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  toggleTitle: { fontSize: 14, fontWeight: "600" },
  toggleSub: { fontSize: 12, marginTop: 2 },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 16, marginBottom: 12 },
  cardLabel: { fontSize: 13, fontWeight: "600", marginBottom: 4 },
  cardValue: { fontSize: 30, fontWeight: "800", fontVariant: ["tabular-nums"] },
  cardValueMulti: { fontSize: 20, fontWeight: "800", fontVariant: ["tabular-nums"], marginTop: 2 },
  cardHint: { fontSize: 12, marginTop: 4 },
  row: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 14, marginBottom: 8 },
  rowTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  rowSym: { fontSize: 15, fontWeight: "700", flex: 1, marginRight: 10 },
  rowGain: { fontSize: 15, fontWeight: "700", fontVariant: ["tabular-nums"] },
  rowMeta: { fontSize: 12, marginTop: 3 },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  empty: { fontSize: 14, textAlign: "center", paddingVertical: 32 },
});
