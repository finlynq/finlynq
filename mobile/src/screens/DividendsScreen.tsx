// Dividend income — grouped by year / quarter / holding. Reads
// GET /api/portfolio/dividends?groupBy=&reportingCurrency=1 (enveloped).
//
// Requested in REPORTING mode (FINLYNQ-182, same as the web report): totals
// and group amounts are the STORED historical `reporting_amount`s, all in
// `reportingCurrency`, so the headline total never sums mixed currencies.
// Rows not yet re-rated are excluded server-side and surfaced as
// `unratedCount`. If an older server ignores the flag (no `mode` echoed), the
// screen falls back to per-currency totals rather than mislabelling a sum.
import React, { useCallback, useEffect, useRef, useState } from "react";
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
import { logger } from "../lib/logger";
import { formatCurrency } from "../lib/format";
import { currencyTotals } from "../lib/portfolio/format";
import { Icon } from "../components/icon";
import type { DividendIncomeResult } from "../../../shared/types";
import type { PortfolioStackParamList } from "../navigation/PortfolioStack";

type Props = NativeStackScreenProps<PortfolioStackParamList, "Dividends">;
type GroupBy = "year" | "quarter" | "holding";

export default function DividendsScreen({ navigation, route }: Props) {
  const { colors } = useTheme();
  const [groupBy, setGroupBy] = useState<GroupBy>("year");
  const [data, setData] = useState<DividendIncomeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(async (g: GroupBy, isRefresh: boolean) => {
    const seq = ++seqRef.current;
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const res = await endpoints.getDividends(`groupBy=${g}&reportingCurrency=1`);
      if (seq !== seqRef.current) return;
      if (res.success) {
        setData(res.data);
        setError(null);
      } else {
        logger.warn("dividends", "fetch failed", { error: res.error });
        setError(res.error);
      }
    } catch (e) {
      if (seq !== seqRef.current) return;
      logger.error("dividends", "fetch threw", { detail: String(e) });
      setError("Cannot connect to server");
    } finally {
      if (isRefresh) setRefreshing(false);
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(groupBy, false);
  }, [groupBy, load]);

  const reporting = data?.mode === "reporting";
  // Server-provided reporting currency first; USD is the app-wide default.
  const reportingCcy = data?.reportingCurrency ?? route.params?.displayCurrency ?? "USD";
  const groups = data?.groups ?? [];
  const payments = data?.totals.rowCount ?? 0;
  const unrated = reporting ? data?.totals.unratedCount ?? 0 : 0;
  // Native fallback: one line per currency, never one mixed-currency sum.
  const nativeTotals = reporting ? [] : currencyTotals(data?.totals.byCurrency, (v) => v);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
          <Icon name="back" size={20} color={colors.primary} />
          <Text style={[styles.backText, { color: colors.primary }]}>Portfolio</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.foreground }]}>Dividend income</Text>
        <View style={{ width: 70 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(groupBy, true)} />}
      >
        <View style={styles.chipRow}>
          {(["year", "quarter", "holding"] as GroupBy[]).map((g) => {
            const active = groupBy === g;
            return (
              <TouchableOpacity
                key={g}
                onPress={() => setGroupBy(g)}
                style={[
                  styles.chip,
                  {
                    backgroundColor: active ? colors.primary : colors.secondary,
                    borderColor: active ? colors.primary : colors.border,
                  },
                ]}
              >
                <Text
                  style={{
                    color: active ? colors.primaryForeground : colors.foreground,
                    fontSize: 13,
                    fontWeight: "600",
                  }}
                >
                  By {g}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {loading ? (
          <ActivityIndicator style={{ marginTop: 32 }} size="large" color={colors.primary} />
        ) : error ? (
          <Text style={[styles.empty, { color: colors.destructive }]}>{error}</Text>
        ) : (
          <>
            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.cardLabel, { color: colors.mutedForeground }]}>
                {reporting ? `Total dividends (${reportingCcy})` : "Total dividends"}
              </Text>
              {reporting || nativeTotals.length === 0 ? (
                <Text style={[styles.cardValue, { color: colors.foreground }]}>
                  {formatCurrency(reporting ? data?.totals.amount ?? 0 : 0, reportingCcy, { decimals: 0 })}
                </Text>
              ) : (
                nativeTotals.map((t) => (
                  <Text
                    key={t.currency}
                    style={[
                      nativeTotals.length === 1 ? styles.cardValue : styles.cardValueMulti,
                      { color: colors.foreground },
                    ]}
                  >
                    {formatCurrency(t.amount, t.currency, { decimals: 0 })}
                    {nativeTotals.length > 1 ? ` ${t.currency}` : ""}
                  </Text>
                ))
              )}
              <Text style={[styles.cardHint, { color: colors.mutedForeground }]}>
                {payments} payment{payments === 1 ? "" : "s"}
              </Text>
              {unrated > 0 && (
                <Text style={[styles.cardWarn, { color: colors.primary }]}>
                  Re-rating in progress: {unrated} payment{unrated === 1 ? "" : "s"} not yet converted to{" "}
                  {reportingCcy} and excluded from the totals. Pull down to refresh shortly.
                </Text>
              )}
            </View>

            {groups.length === 0 ? (
              <Text style={[styles.empty, { color: colors.mutedForeground }]}>
                No dividend income recorded.
              </Text>
            ) : (
              groups.map((g, i) => (
                <View
                  key={`${g.bucket}-${i}`}
                  style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border }]}
                >
                  <View style={styles.rowTop}>
                    <Text style={[styles.rowLabel, { color: colors.foreground }]} numberOfLines={1}>
                      {g.label}
                    </Text>
                    <Text style={[styles.rowAmt, { color: colors.foreground }]}>
                      {/* Reporting-mode group amounts are all in reportingCcy;
                          g.currency can name the first row's NATIVE currency
                          when that row was still unrated. */}
                      {formatCurrency(g.amount, reporting ? reportingCcy : g.currency, { decimals: 0 })}
                    </Text>
                  </View>
                  <Text style={[styles.rowMeta, { color: colors.mutedForeground }]}>
                    {g.rowCount} payment{g.rowCount === 1 ? "" : "s"}
                    {g.reinvestedCount > 0 ? ` · ${g.reinvestedCount} reinvested` : ""}
                    {g.withholdingCount > 0 ? ` · ${g.withholdingCount} withholding` : ""}
                    {(g.unratedCount ?? 0) > 0 ? ` · ${g.unratedCount} pending re-rate` : ""}
                  </Text>
                </View>
              ))
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
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
  chipRow: { flexDirection: "row", gap: 8, marginBottom: 12 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 16, marginBottom: 12 },
  cardLabel: { fontSize: 13, fontWeight: "600", marginBottom: 4 },
  cardValue: { fontSize: 30, fontWeight: "800", fontVariant: ["tabular-nums"] },
  cardValueMulti: { fontSize: 20, fontWeight: "800", fontVariant: ["tabular-nums"], marginTop: 2 },
  cardHint: { fontSize: 12, marginTop: 4 },
  cardWarn: { fontSize: 12, marginTop: 6 },
  row: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 14, marginBottom: 8 },
  rowTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  rowLabel: { fontSize: 15, fontWeight: "700", flex: 1, marginRight: 10 },
  rowAmt: { fontSize: 15, fontWeight: "700", fontVariant: ["tabular-nums"] },
  rowMeta: { fontSize: 12, marginTop: 3 },
  empty: { fontSize: 14, textAlign: "center", paddingVertical: 32 },
});
