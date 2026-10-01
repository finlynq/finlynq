// Holding drill-down: aggregated header + per-account rows + open lots + a
// transaction list, with Buy/Sell shortcuts. `members` are the per-account
// EnrichedHolding rows that the overview pooled into this byHolding summary.
//
// The route params are only the SEED: every time the screen regains focus
// (e.g. returning from a Buy/Sell op form) and on pull-to-refresh, it re-reads
// its own row out of GET /api/portfolio/overview plus the lots + transactions,
// so the header, per-account rows and lots never go stale after a trade.
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
import { useIsFocused } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { formatCurrency, safeName, formatShortDate } from "../lib/format";
import { findHoldingInOverview, holdingDescription } from "../lib/portfolio/holdings";
import { formatPerShare, formatQty } from "../lib/portfolio/format";
import { Icon } from "../components/icon";
import type {
  EnrichedHolding,
  LotRow,
  PortfolioHoldingSummary,
  Transaction,
} from "../../../shared/types";
import type { PortfolioStackParamList } from "../navigation/PortfolioStack";

type Props = NativeStackScreenProps<PortfolioStackParamList, "HoldingDetail">;

function gainTone(colors: ReturnType<typeof useTheme>["colors"], v: number) {
  return v > 0 ? colors.pos : v < 0 ? colors.neg : colors.foreground;
}

export default function HoldingDetailScreen({ navigation, route }: Props) {
  const { colors } = useTheme();
  const isFocused = useIsFocused();
  const [summary, setSummary] = useState<PortfolioHoldingSummary>(route.params.summary);
  const [members, setMembers] = useState<EnrichedHolding[]>(route.params.members);
  const [displayCurrency, setDisplayCurrency] = useState(route.params.displayCurrency || "USD");
  const [lots, setLots] = useState<LotRow[]>([]);
  const [txns, setTxns] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Latest members for the stable callbacks below; a sequence number drops
  // responses from a superseded load (focus + pull-to-refresh can overlap).
  const membersRef = useRef(members);
  membersRef.current = members;
  const seqRef = useRef(0);
  const focusCountRef = useRef(0);
  const holdingKey = route.params.summary.key;

  const loadDetail = useCallback(async (ms: EnrichedHolding[], seq: number) => {
    try {
      const results = await Promise.all(
        ms.flatMap((m) => [
          endpoints.getPortfolioLots(m.id, m.accountId ?? undefined),
          endpoints.getTransactions(`portfolioHoldingId=${m.id}&sort=date&sortDir=desc&limit=50`),
        ])
      );
      if (seq !== seqRef.current) return;
      const allLots: LotRow[] = [];
      const allTx: Transaction[] = [];
      results.forEach((res, i) => {
        if (i % 2 === 0) {
          // lots result
          if (res.success && res.data && "lots" in res.data) {
            allLots.push(...(res.data as { lots: LotRow[] }).lots);
          }
        } else if (res.success && Array.isArray(res.data)) {
          allTx.push(...(res.data as Transaction[]));
        }
      });
      allTx.sort((a, b) => (a.date < b.date ? 1 : -1));
      setLots(allLots);
      setTxns(allTx);
    } catch (e) {
      logger.error("holding-detail", "load threw", { detail: String(e) });
    }
  }, []);

  // Re-read this holding's row from the overview, then its lots + transactions.
  const reload = useCallback(
    async (seq: number) => {
      let ms = membersRef.current;
      try {
        const res = await endpoints.getPortfolioOverview();
        if (seq !== seqRef.current) return;
        if (res.success) {
          const found = findHoldingInOverview(res.data, holdingKey);
          if (found) {
            setSummary(found.summary);
            setMembers(found.members);
            ms = found.members;
          }
          if (res.data.displayCurrency) setDisplayCurrency(res.data.displayCurrency);
        } else {
          logger.warn("holding-detail", "overview refresh failed", { error: res.error });
        }
      } catch (e) {
        logger.error("holding-detail", "overview refresh threw", { detail: String(e) });
      }
      await loadDetail(ms, seq);
    },
    [holdingKey, loadDetail]
  );

  useEffect(() => {
    if (!isFocused) return;
    focusCountRef.current += 1;
    const seq = ++seqRef.current;
    // First focus: the route params are fresh, only lots/txns are missing.
    // Every later focus (back from a Buy/Sell form) re-reads the overview row
    // in the background — content stays on screen while it loads.
    const run = focusCountRef.current === 1 ? loadDetail(membersRef.current, seq) : reload(seq);
    void run.finally(() => {
      if (seq === seqRef.current) setLoading(false);
    });
  }, [isFocused, loadDetail, reload]);

  const onRefresh = useCallback(() => {
    const seq = ++seqRef.current;
    setRefreshing(true);
    void reload(seq).finally(() => {
      // Always drop the pull indicator, even if a focus reload superseded us.
      setRefreshing(false);
      if (seq === seqRef.current) setLoading(false);
    });
  }, [reload]);

  const accountNameById = new Map<number, string>();
  for (const m of members) {
    if (m.accountId != null) accountNameById.set(m.accountId, m.accountName);
  }
  // The first member's (account, holding) anchors the Buy/Sell shortcuts.
  const primary = members[0];
  const isCash = summary.assetType === "cash";

  const mv = summary.marketValueDisplay;
  const unreal = summary.unrealizedGainDisplay;
  // FINLYNQ-242: lead with the description; ticker drops to the subtitle.
  const desc = holdingDescription({ description: summary.description, name: summary.name, symbol: summary.symbol });
  const ticker = safeName(summary.symbol || summary.name, "—");

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
          <Icon name="back" size={20} color={colors.primary} />
          <Text style={[styles.backText, { color: colors.primary }]}>Portfolio</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
          {desc ?? ticker}
        </Text>
        <View style={{ width: 70 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <Text style={[styles.subtitle, { color: colors.mutedForeground }]} numberOfLines={1}>
          {desc != null ? `${ticker} · ` : ""}{summary.assetType}
          {primary ? ` · ${primary.currency}` : ""}
        </Text>

        {/* Market value card */}
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.cardLabel, { color: colors.mutedForeground }]}>Market value</Text>
          <Text style={[styles.cardValue, { color: colors.foreground }]}>
            {formatCurrency(mv, displayCurrency, { decimals: 0 })}
          </Text>
          <Text style={[styles.cardSub, { color: gainTone(colors, unreal) }]}>
            {unreal >= 0 ? "+" : ""}
            {formatCurrency(unreal, displayCurrency, { decimals: 0 })}
            {summary.unrealizedGainPct != null
              ? ` · ${summary.unrealizedGainPct >= 0 ? "+" : ""}${summary.unrealizedGainPct.toFixed(1)}%`
              : ""}
          </Text>
          <View style={styles.kvBlock}>
            <KV
              k={`${formatQty(summary.totalQty)} units @ avg cost`}
              v={summary.avgCostDisplay != null ? formatPerShare(summary.avgCostDisplay, displayCurrency) : "—"}
            />
            <KV k="Cost basis" v={formatCurrency(summary.costBasisDisplay, displayCurrency, { decimals: 0 })} />
            <KV
              k="Realized G/L"
              v={`${summary.realizedGainDisplay >= 0 ? "+" : ""}${formatCurrency(summary.realizedGainDisplay, displayCurrency, { decimals: 0 })}`}
              tone={gainTone(colors, summary.realizedGainDisplay)}
            />
            <KV k="Dividends" v={formatCurrency(summary.dividendsDisplay, displayCurrency, { decimals: 0 })} />
          </View>
        </View>

        {/* By account */}
        <Text style={[styles.section, { color: colors.mutedForeground }]}>By account</Text>
        <View style={[styles.listCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {members.map((m) => (
            <View key={m.id} style={[styles.listRow, { borderBottomColor: colors.border }]}>
              <View style={styles.listMain}>
                <Text style={[styles.listTitle, { color: colors.foreground }]} numberOfLines={1}>
                  {safeName(m.accountName)} · {m.currency}
                </Text>
                <Text style={[styles.listSub, { color: colors.mutedForeground }]} numberOfLines={1}>
                  {m.firstPurchaseDate ? `first buy ${m.firstPurchaseDate}` : "—"}
                  {m.daysHeld != null ? ` · ${m.daysHeld}d held` : ""}
                </Text>
              </View>
              <View style={styles.listRight}>
                <Text style={[styles.listAmt, { color: colors.foreground }]}>
                  {formatCurrency(m.marketValueDisplay ?? 0, displayCurrency, { decimals: 0 })}
                </Text>
                <Text style={[styles.listMeta, { color: colors.mutedForeground }]}>
                  {formatQty(m.quantity)} units
                </Text>
              </View>
            </View>
          ))}
        </View>

        {/* Open lots */}
        {!isCash && (
          <>
            <Text style={[styles.section, { color: colors.mutedForeground }]}>Open lots</Text>
            <View style={[styles.listCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              {loading ? (
                <ActivityIndicator style={{ paddingVertical: 16 }} color={colors.primary} />
              ) : lots.length === 0 ? (
                <Text style={[styles.emptyInline, { color: colors.mutedForeground }]}>No open lots</Text>
              ) : (
                lots.map((l) => (
                  <View key={l.lotId} style={[styles.listRow, { borderBottomColor: colors.border }]}>
                    <View style={styles.listMain}>
                      <Text style={[styles.listTitle, { color: colors.foreground }]}>
                        {formatShortDate(l.openDate)}
                      </Text>
                      <Text style={[styles.listSub, { color: colors.mutedForeground }]} numberOfLines={1}>
                        {safeName(accountNameById.get(l.accountId), "—")} · {formatQty(l.qtyRemaining)} units
                      </Text>
                    </View>
                    <Text style={[styles.listAmt, { color: colors.foreground }]}>
                      @ {formatPerShare(l.costPerShare, l.currency)}
                    </Text>
                  </View>
                ))
              )}
            </View>
          </>
        )}

        {/* Transactions */}
        <Text style={[styles.section, { color: colors.mutedForeground }]}>Transactions</Text>
        <View style={[styles.listCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {loading ? (
            <ActivityIndicator style={{ paddingVertical: 16 }} color={colors.primary} />
          ) : txns.length === 0 ? (
            <Text style={[styles.emptyInline, { color: colors.mutedForeground }]}>No transactions</Text>
          ) : (
            txns.slice(0, 25).map((t) => (
              <View key={t.id} style={[styles.listRow, { borderBottomColor: colors.border }]}>
                <View style={styles.listMain}>
                  <Text style={[styles.listTitle, { color: colors.foreground }]} numberOfLines={1}>
                    {safeName(t.payee || t.note, "Transaction")}
                  </Text>
                  <Text style={[styles.listSub, { color: colors.mutedForeground }]}>
                    {formatShortDate(t.date)}
                  </Text>
                </View>
                <View style={styles.listRight}>
                  <Text style={[styles.listAmt, { color: colors.foreground }]}>
                    {formatCurrency(t.amount, t.currency, { decimals: 0 })}
                  </Text>
                  {t.quantity != null && t.quantity !== 0 && (
                    <Text style={[styles.listMeta, { color: colors.mutedForeground }]}>
                      {t.quantity > 0 ? "+" : ""}
                      {formatQty(t.quantity)}u
                    </Text>
                  )}
                </View>
              </View>
            ))
          )}
        </View>

        {/* Buy / Sell shortcuts */}
        {!isCash && primary && primary.accountId != null && (
          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: colors.primary }]}
              onPress={() =>
                navigation.navigate("OperationForm", {
                  op: "buy",
                  preselectAccountId: primary.accountId!,
                  preselectHoldingId: primary.id,
                })
              }
            >
              <Text style={[styles.actionText, { color: colors.primaryForeground }]}>+ Buy</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: colors.secondary }]}
              onPress={() =>
                navigation.navigate("OperationForm", {
                  op: "sell",
                  preselectAccountId: primary.accountId!,
                  preselectHoldingId: primary.id,
                })
              }
            >
              <Text style={[styles.actionText, { color: colors.foreground }]}>− Sell</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function KV({ k, v, tone }: { k: string; v: string; tone?: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.kvRow}>
      <Text style={[styles.kvKey, { color: colors.mutedForeground }]} numberOfLines={1}>
        {k}
      </Text>
      <Text style={[styles.kvVal, { color: tone ?? colors.foreground }]}>{v}</Text>
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
  title: { fontSize: 17, fontWeight: "700", flex: 1, textAlign: "center" },
  scroll: { padding: 16, paddingBottom: 32 },
  subtitle: { fontSize: 13, marginBottom: 12 },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 16, marginBottom: 12 },
  cardLabel: { fontSize: 13, fontWeight: "600", marginBottom: 4 },
  cardValue: { fontSize: 30, fontWeight: "800", fontVariant: ["tabular-nums"] },
  cardSub: { fontSize: 14, fontWeight: "700", marginTop: 4, fontVariant: ["tabular-nums"] },
  kvBlock: { marginTop: 12 },
  kvRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 5 },
  kvKey: { fontSize: 13, flex: 1, marginRight: 12 },
  kvVal: { fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] },
  section: { fontSize: 12, fontWeight: "700", textTransform: "uppercase", marginBottom: 6, marginTop: 4 },
  listCard: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    marginBottom: 12,
  },
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  listMain: { flex: 1, marginRight: 10 },
  listTitle: { fontSize: 14, fontWeight: "600", fontVariant: ["tabular-nums"] },
  listSub: { fontSize: 12, marginTop: 2 },
  listRight: { alignItems: "flex-end" },
  listAmt: { fontSize: 14, fontWeight: "600", fontVariant: ["tabular-nums"] },
  listMeta: { fontSize: 12, marginTop: 2 },
  emptyInline: { fontSize: 13, textAlign: "center", paddingVertical: 16 },
  actions: { flexDirection: "row", gap: 10, marginTop: 4 },
  actionBtn: { flex: 1, paddingVertical: 13, borderRadius: 10, alignItems: "center" },
  actionText: { fontSize: 15, fontWeight: "700" },
});
