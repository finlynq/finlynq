// The sales of one position and the lots each one used, with a way to change
// the matching. The mobile counterpart of the web's Lot inspector.
//
// One sale is changed at a time: choose how many shares it takes from each lot
// (the total must equal what was sold), look at the preview, then save. Nothing
// about the transactions changes; only which purchases the sale is matched to,
// and so its realized gain and the cost of what is still held.
//
// The server checks everything again and saves all of a change or none of it.
// Two of its rules are applied here first (see lib/portfolio/lots.ts): a
// purchase made after the sale can't be newly chosen, and a sale that sold
// more than was held carries that part as "Sold short" (sent as lot 0). A sale
// whose short a later purchase already closed can't be changed here at all.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
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
import { formatCurrency, safeName } from "../lib/format";
import { formatPerShare, formatQty, signedMoney } from "../lib/portfolio/format";
import {
  allocationMatches,
  allocationTotal,
  allocationUnchanged,
  buildPerLotQty,
  groupSales,
  isReassignableSale,
  laterLotOverLimit,
  saleLotChoices,
  seedAllocation,
  shortAlreadyCovered,
  SHORT_LOT_ID,
  type LotSale,
} from "../lib/portfolio/lots";
import { Icon } from "../components/icon";
import type { HoldingLot, LotClosure, LotReassignPreview } from "../../../shared/types";
import type { PortfolioStackParamList } from "../navigation/PortfolioStack";

type Props = NativeStackScreenProps<PortfolioStackParamList, "LotSales">;

const NETWORK_ERROR = "Cannot connect to server";

export default function LotSalesScreen({ navigation, route }: Props) {
  const { colors } = useTheme();
  const { holdingId, accountId, title, accountName } = route.params;

  const [lots, setLots] = useState<HoldingLot[]>([]);
  const [closures, setClosures] = useState<LotClosure[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which cost-basis method is in use; null when the server cannot say.
  const [lotsInUse, setLotsInUse] = useState<boolean | null>(null);

  // The sale being re-matched: shares per lot as typed, and the last preview.
  const [editing, setEditing] = useState<LotSale | null>(null);
  const [alloc, setAlloc] = useState<Record<number, string>>({});
  const [preview, setPreview] = useState<LotReassignPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(
    async (isRefresh = false) => {
      const mine = ++seq.current;
      if (isRefresh) setRefreshing(true);
      try {
        const res = await endpoints.getHoldingLots(holdingId, accountId);
        if (mine !== seq.current) return;
        if (res.success && Array.isArray(res.data?.lots) && Array.isArray(res.data?.closures)) {
          setLots(res.data.lots);
          setClosures(res.data.closures);
          setError(null);
        } else {
          const message = res.success ? "The lots could not be read." : res.error;
          logger.warn("lot-sales", "load failed", { error: message });
          setError(message);
        }
      } catch (e) {
        logger.error("lot-sales", "load threw", { detail: String(e) });
        if (mine === seq.current) setError(NETWORK_ERROR);
      } finally {
        if (mine === seq.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [holdingId, accountId],
  );

  useEffect(() => {
    load();
    // The method note is optional: a server without the setting leaves it out.
    endpoints
      .getLotAllocation()
      .then((r) => {
        if (r.success) setLotsInUse(r.data.enabled);
      })
      .catch(() => {});
    return () => {
      seq.current++;
    };
  }, [load]);

  const sales = useMemo(() => groupSales(closures, lots), [closures, lots]);
  const lotById = useMemo(() => new Map(lots.map((l) => [l.id, l])), [lots]);
  const choices = useMemo(() => (editing ? saleLotChoices(lots, editing) : []), [lots, editing]);
  const total = allocationTotal(alloc);
  const matches = editing ? allocationMatches(alloc, editing) : false;
  const unchanged = editing ? allocationUnchanged(alloc, editing) : true;
  const overLimit = editing ? laterLotOverLimit(alloc, choices) : false;
  const cannotPreview = busy || !matches || unchanged || overLimit;

  const startEdit = (sale: LotSale) => {
    setEditing(sale);
    setAlloc(seedAllocation(sale));
    setPreview(null);
    setEditError(null);
    setNotice(null);
  };
  const cancelEdit = () => {
    if (busy) return;
    setEditing(null);
    setPreview(null);
    setEditError(null);
  };

  /** Ask the server what this choice would do (`commit` false), or do it. */
  const send = async (commit: boolean) => {
    if (!editing || busy) return;
    setBusy(true);
    setEditError(null);
    try {
      const res = await endpoints.reassignLots(holdingId, {
        closeTxId: editing.closeTxId,
        perLotQty: buildPerLotQty(alloc),
        preview: !commit,
      });
      if (!res.success) {
        logger.warn("lot-sales", commit ? "save rejected" : "preview rejected", { error: res.error });
        setEditError(res.error || "Please try again.");
        return;
      }
      if (!commit) {
        setPreview(res.data.preview);
        return;
      }
      setEditing(null);
      setPreview(null);
      setNotice("The sale now uses the lots you chose.");
      await load();
    } catch (e) {
      logger.error("lot-sales", "reassign threw", { detail: String(e) });
      setEditError(NETWORK_ERROR);
    } finally {
      setBusy(false);
    }
  };

  const lotLine = (c: LotClosure) => {
    const lot = lotById.get(c.lotId);
    return `${formatQty(c.qtyClosed)} from ${lot ? lot.openDate : `lot #${c.lotId}`} @ ${formatPerShare(c.costPerShare, c.currency)}`;
  };

  const renderEditor = (sale: LotSale) => {
    const gainChange = preview
      ? Object.entries(preview.realizedGainDeltaByYear).filter(([, v]) => Math.abs(v) >= 0.005)
      : [];
    return (
      <View>
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.cardTitle, { color: colors.foreground }]}>
            Sale on {sale.closeDate}: {formatQty(sale.qty)} units
          </Text>
          <Text style={[styles.body, { color: colors.mutedForeground }]}>
            Choose how many units this sale takes from each purchase. The total must equal {formatQty(sale.qty)}.
          </Text>

          {choices.length === 0 && sale.soldShort <= 0 ? (
            <Text style={[styles.body, { color: colors.mutedForeground }]}>
              There is no purchase on or before this sale to match it to.
            </Text>
          ) : null}
          {choices.map((ch) => (
            <View key={ch.lot.id} style={[styles.choiceRow, { borderTopColor: colors.border }]}>
              <View style={styles.choiceMain}>
                <Text style={[styles.choiceTitle, { color: colors.foreground }]}>Bought {ch.lot.openDate}</Text>
                <Text style={[styles.choiceSub, { color: colors.mutedForeground }]} numberOfLines={1}>
                  @ {formatPerShare(ch.lot.costPerShare, ch.lot.currency)} · up to {formatQty(ch.available)}
                </Text>
                {ch.boughtAfterSale ? (
                  <Text style={[styles.choiceSub, { color: colors.destructive }]}>
                    Bought after this sale: it can keep up to {formatQty(ch.available)} units, not more.
                  </Text>
                ) : null}
              </View>
              <TextInput
                accessibilityLabel={`Units from the purchase on ${ch.lot.openDate}`}
                style={[styles.qtyInput, { color: colors.foreground, borderColor: colors.input }]}
                value={alloc[ch.lot.id] ?? ""}
                onChangeText={(t) => {
                  // A preview describes one exact choice; any change voids it.
                  setPreview(null);
                  setAlloc((a) => ({ ...a, [ch.lot.id]: t }));
                }}
                keyboardType="decimal-pad"
                placeholder="0"
                placeholderTextColor={colors.mutedForeground}
              />
            </View>
          ))}

          {sale.soldShort > 0 ? (
            <View style={[styles.choiceRow, { borderTopColor: colors.border }]}>
              <View style={styles.choiceMain}>
                <Text style={[styles.choiceTitle, { color: colors.destructive }]}>Sold short</Text>
                <Text style={[styles.choiceSub, { color: colors.mutedForeground }]}>
                  Beyond the units held · {formatQty(sale.soldShort)} sold short now
                </Text>
              </View>
              <TextInput
                accessibilityLabel="Units sold short"
                style={[styles.qtyInput, { color: colors.foreground, borderColor: colors.input }]}
                value={alloc[SHORT_LOT_ID] ?? ""}
                onChangeText={(t) => {
                  setPreview(null);
                  setAlloc((a) => ({ ...a, [SHORT_LOT_ID]: t }));
                }}
                keyboardType="decimal-pad"
                placeholder="0"
                placeholderTextColor={colors.mutedForeground}
              />
            </View>
          ) : null}

          <Text style={[styles.total, { color: matches ? colors.pos : colors.destructive }]}>
            {formatQty(total)} of {formatQty(sale.qty)} units chosen
          </Text>
        </View>

        {preview ? (
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.primary }]}>
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>What changes</Text>
            {gainChange.length === 0 ? (
              <Text style={[styles.body, { color: colors.mutedForeground }]}>
                The realized gain on this sale stays the same.
              </Text>
            ) : (
              gainChange.map(([year, delta]) => (
                <Text key={year} style={[styles.body, { color: colors.foreground }]}>
                  Realized gain in {year}: {signedMoney(delta, sale.currency)}
                </Text>
              ))
            )}
            {preview.openedShortLots.length > 0 ? (
              <Text style={[styles.body, { color: colors.destructive }]}>
                This takes more than those purchases hold, so{" "}
                {preview.openedShortLots.map((s) => formatQty(s.qty)).join(", ")} units would be recorded as sold
                short.
              </Text>
            ) : null}
          </View>
        ) : null}

        {editError ? <Text style={[styles.error, { color: colors.destructive }]}>{editError}</Text> : null}

        <View style={styles.buttons}>
          <TouchableOpacity
            accessibilityRole="button"
            onPress={busy ? undefined : cancelEdit}
            style={[styles.secondaryBtn, { borderColor: colors.border }]}
          >
            <Text style={[styles.secondaryText, { color: colors.foreground }]}>Cancel</Text>
          </TouchableOpacity>
          {preview ? (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Save the new lots"
              onPress={busy ? undefined : () => void send(true)}
              style={[styles.primaryBtn, { backgroundColor: colors.primary, opacity: busy ? 0.6 : 1 }]}
            >
              {busy ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : (
                <Text style={[styles.primaryText, { color: colors.primaryForeground }]}>Save</Text>
              )}
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Preview the change"
              // Nothing to preview until the units add up, something differs and
              // no purchase made after the sale is asked for more than it keeps.
              onPress={cannotPreview ? undefined : () => void send(false)}
              style={[styles.primaryBtn, { backgroundColor: colors.primary, opacity: cannotPreview ? 0.5 : 1 }]}
            >
              {busy ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : (
                <Text style={[styles.primaryText, { color: colors.primaryForeground }]}>Preview</Text>
              )}
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity
          style={styles.back}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Icon name="back" size={20} color={colors.primary} />
          <Text style={[styles.backText, { color: colors.primary }]}>Back</Text>
        </TouchableOpacity>
        <View style={styles.titleWrap}>
          <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
            Sales and lots
          </Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]} numberOfLines={1}>
            {safeName(title)}
            {accountName ? ` · ${safeName(accountName)}` : ""}
          </Text>
        </View>
        <View style={{ width: 70 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} />}
      >
        {lotsInUse === false ? (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Cost basis method"
            onPress={() => navigation.navigate("CostBasis")}
            style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <Text style={[styles.body, { color: colors.mutedForeground, marginBottom: 0 }]}>
              Your cost basis uses the simple average, so these lots do not change your figures yet.{" "}
              <Text style={{ color: colors.primary }}>Switch to advanced lot allocation</Text>
            </Text>
          </TouchableOpacity>
        ) : null}

        {loading ? <ActivityIndicator style={{ marginTop: 32 }} size="large" color={colors.primary} /> : null}
        {error ? <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text> : null}
        {notice && !editing ? <Text style={[styles.notice, { color: colors.pos }]}>{notice}</Text> : null}

        {!loading && !error && editing ? renderEditor(editing) : null}

        {!loading && !error && !editing ? (
          sales.length === 0 ? (
            <Text style={[styles.empty, { color: colors.mutedForeground }]}>
              Nothing has been sold from this position yet.
            </Text>
          ) : (
            sales.map((sale) => (
              <View key={sale.closeTxId} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={styles.saleTop}>
                  <Text style={[styles.cardTitle, { color: colors.foreground, marginBottom: 0 }]}>
                    {sale.closeDate}
                  </Text>
                  <Text
                    style={[
                      styles.saleGain,
                      { color: sale.realizedGain > 0 ? colors.pos : sale.realizedGain < 0 ? colors.neg : colors.foreground },
                    ]}
                  >
                    {signedMoney(sale.realizedGain, sale.currency)}
                  </Text>
                </View>
                <Text style={[styles.body, { color: colors.mutedForeground }]}>
                  {isReassignableSale(sale) ? "Sold" : sale.closeKind.replace(/_/g, " ")} {formatQty(sale.qty)} units @{" "}
                  {formatCurrency(sale.proceedsPerShare, sale.currency)}
                  {sale.soldShort > 0 ? ` · ${formatQty(sale.soldShort)} of them sold short` : ""}
                </Text>
                {sale.closures.map((c) => (
                  <Text key={c.id} style={[styles.lotLine, { color: colors.foreground }]}>
                    {lotLine(c)}
                  </Text>
                ))}
                {sale.closures.some((c) => c.openAfterClose) ? (
                  <Text style={[styles.body, { color: colors.destructive, marginTop: 6, marginBottom: 0 }]}>
                    This sale is matched to a purchase made after it.
                    {isReassignableSale(sale) ? " Change its lots to match it to an earlier one." : ""}
                  </Text>
                ) : null}
                {isReassignableSale(sale) && shortAlreadyCovered(sale) ? (
                  <Text style={[styles.body, { color: colors.mutedForeground, marginTop: 6, marginBottom: 0 }]}>
                    A later purchase already closed {formatQty(sale.shortCovered)} of the units this sale sold short,
                    so its lots can't be changed here: that would undo the purchase. Rebuild lots on the web app
                    re-matches every trade in date order.
                  </Text>
                ) : null}
                {isReassignableSale(sale) && !shortAlreadyCovered(sale) ? (
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={`Change the lots of the sale on ${sale.closeDate}`}
                    onPress={() => startEdit(sale)}
                    style={[styles.changeBtn, { borderColor: colors.primary }]}
                  >
                    <Text style={[styles.changeText, { color: colors.primary }]}>Change lots</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            ))
          )
        ) : null}
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
  back: { flexDirection: "row", alignItems: "center", gap: 2, width: 70 },
  backText: { fontSize: 15, fontWeight: "600" },
  titleWrap: { flex: 1, alignItems: "center" },
  title: { fontSize: 17, fontWeight: "700" },
  subtitle: { fontSize: 12, marginTop: 1 },
  scroll: { padding: 16, paddingBottom: 32 },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 14, marginBottom: 12 },
  cardTitle: { fontSize: 15, fontWeight: "700", marginBottom: 6 },
  body: { fontSize: 13, lineHeight: 19, marginBottom: 8 },
  saleTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 },
  saleGain: { fontSize: 14, fontWeight: "700", fontVariant: ["tabular-nums"] },
  lotLine: { fontSize: 13, fontVariant: ["tabular-nums"], marginBottom: 3 },
  changeBtn: { alignSelf: "flex-start", borderRadius: 8, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8, marginTop: 8 },
  changeText: { fontSize: 14, fontWeight: "700" },
  choiceRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  choiceMain: { flex: 1, marginRight: 10 },
  choiceTitle: { fontSize: 14, fontWeight: "600" },
  choiceSub: { fontSize: 12, marginTop: 2, fontVariant: ["tabular-nums"] },
  qtyInput: {
    minWidth: 84,
    height: 40,
    borderWidth: 1,
    borderRadius: 8,
    textAlign: "center",
    fontSize: 15,
    fontVariant: ["tabular-nums"],
    paddingVertical: 0,
  },
  total: { fontSize: 13, fontWeight: "700", marginTop: 10, fontVariant: ["tabular-nums"] },
  buttons: { flexDirection: "row", justifyContent: "flex-end" },
  secondaryBtn: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingVertical: 11, marginRight: 8 },
  secondaryText: { fontSize: 14, fontWeight: "600" },
  primaryBtn: { borderRadius: 8, paddingHorizontal: 22, paddingVertical: 11, minWidth: 96, alignItems: "center" },
  primaryText: { fontSize: 15, fontWeight: "700" },
  error: { fontSize: 14, marginBottom: 12 },
  notice: { fontSize: 13, marginBottom: 12 },
  empty: { fontSize: 14, textAlign: "center", paddingVertical: 32 },
});
