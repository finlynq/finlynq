// Balance sheet — assets, liabilities, net worth as of TODAY. The server's
// balance-sheet route ignores endDate and always returns current balances
// (investment accounts marked to market now), so this screen never claims a
// historical date: it asks for today and labels the result "current balances".
// Accounts grouped by account-group; each row shows the FX-converted balance
// (display currency) plus the native balance when it differs. Reads
// GET /api/reports?type=balance-sheet (bare JSON, balances converted server-side).
import React, { useCallback, useMemo } from "react";
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
import { formatCurrency, safeName, formatShortDate } from "../lib/format";
import { localDateISO } from "../lib/subscriptions";
import { useReportData } from "../lib/reports/use-report-data";
import { Icon } from "../components/icon";
import type { MoreStackParamList } from "../navigation/MoreStack";
import type { BalanceSheetRow } from "../../../shared/types";

type Props = NativeStackScreenProps<MoreStackParamList, "BalanceSheet">;

interface AccountGroup {
  name: string;
  rows: BalanceSheetRow[];
  total: number;
}

function groupRows(rows: BalanceSheetRow[]): AccountGroup[] {
  const map = new Map<string, AccountGroup>();
  for (const r of rows) {
    const g = r.accountGroup && r.accountGroup.trim().length > 0 ? r.accountGroup : "Other";
    if (!map.has(g)) map.set(g, { name: g, rows: [], total: 0 });
    const bucket = map.get(g)!;
    bucket.rows.push(r);
    bucket.total += r.convertedBalance;
  }
  return Array.from(map.values()).sort((a, z) => z.total - a.total);
}

export default function BalanceSheetScreen({ navigation, route }: Props) {
  const { colors } = useTheme();
  // The route's endDate is deliberately unused: the server ignores it (always
  // current balances), so asking for "today" keeps the request honest.
  const { displayCurrency } = route.params;

  const fetcher = useCallback(() => endpoints.getBalanceSheet({ endDate: localDateISO() }), []);
  const { data, loading, refreshing, error, refresh } = useReportData(fetcher, "balance-sheet");

  const ccy = data?.displayCurrency ?? displayCurrency;
  const assetGroups = useMemo(() => (data ? groupRows(data.assets) : []), [data]);
  const liabilityGroups = useMemo(() => (data ? groupRows(data.liabilities) : []), [data]);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
          <Icon name="back" size={20} color={colors.primary} />
          <Text style={[styles.backText, { color: colors.primary }]}>Reports</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.foreground }]}>Balance sheet</Text>
        <View style={{ width: 70 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} />}
      >
        <Text style={[styles.rangeLabel, { color: colors.mutedForeground }]}>
          Current balances · today, {formatShortDate(localDateISO())}
        </Text>
        <Text style={[styles.rangeNote, { color: colors.mutedForeground }]}>
          {"Always today's balances; the report date range doesn't apply here."}
        </Text>

        {loading ? (
          <ActivityIndicator style={{ marginTop: 40 }} size="large" color={colors.primary} />
        ) : error ? (
          <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text>
        ) : data ? (
          <>
            <View style={[styles.nwCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.nwLabel, { color: colors.mutedForeground }]}>Net worth</Text>
              <Text style={[styles.nwValue, { color: data.netWorth >= 0 ? colors.foreground : colors.neg }]}>
                {formatCurrency(data.netWorth, ccy, { decimals: 0 })}
              </Text>
              <View style={styles.nwSplit}>
                <View>
                  <Text style={[styles.nwSplitLabel, { color: colors.mutedForeground }]}>Assets</Text>
                  <Text style={[styles.nwSplitVal, { color: colors.pos }]}>
                    {formatCurrency(data.totalAssets, ccy, { decimals: 0 })}
                  </Text>
                </View>
                <View>
                  <Text style={[styles.nwSplitLabel, { color: colors.mutedForeground }]}>Liabilities</Text>
                  <Text style={[styles.nwSplitVal, { color: colors.neg }]}>
                    {formatCurrency(data.totalLiabilities, ccy, { decimals: 0 })}
                  </Text>
                </View>
              </View>
            </View>

            <Section
              title="Assets"
              groups={assetGroups}
              total={data.totalAssets}
              ccy={ccy}
              tone="pos"
              emptyText="No asset accounts."
            />
            <Section
              title="Liabilities"
              groups={liabilityGroups}
              total={data.totalLiabilities}
              ccy={ccy}
              tone="neg"
              emptyText="No liability accounts."
            />
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({
  title,
  groups,
  total,
  ccy,
  tone,
  emptyText,
}: {
  title: string;
  groups: AccountGroup[];
  total: number;
  ccy: string;
  tone: "pos" | "neg";
  emptyText: string;
}) {
  const { colors } = useTheme();
  const toneColor = tone === "pos" ? colors.pos : colors.neg;
  return (
    <View style={{ marginTop: 20 }}>
      <Text style={[styles.sectionTitle, { color: colors.foreground }]}>{title}</Text>
      {groups.length === 0 ? (
        <Text style={[styles.empty, { color: colors.mutedForeground }]}>{emptyText}</Text>
      ) : (
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {groups.map((g, gi) => (
            <View key={g.name}>
              <View
                style={[
                  styles.groupRow,
                  gi > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
                ]}
              >
                <Text style={[styles.groupName, { color: colors.mutedForeground }]} numberOfLines={1}>
                  {safeName(g.name).toUpperCase()}
                </Text>
                <Text style={[styles.groupTotal, { color: toneColor }]}>
                  {formatCurrency(g.total, ccy, { decimals: 0 })}
                </Text>
              </View>
              {g.rows.map((r) => {
                const showNative = r.currency !== ccy;
                return (
                  <View key={r.accountId} style={[styles.acctRow, { borderTopColor: colors.border }]}>
                    <Text style={[styles.acctName, { color: colors.foreground }]} numberOfLines={1}>
                      {safeName(r.accountName, "Account")}
                    </Text>
                    <View style={{ alignItems: "flex-end" }}>
                      <Text style={[styles.acctVal, { color: colors.foreground }]}>
                        {formatCurrency(r.convertedBalance, ccy, { decimals: 0 })}
                      </Text>
                      {showNative && (
                        <Text style={[styles.acctNative, { color: colors.mutedForeground }]}>
                          {formatCurrency(r.balance, r.currency, { decimals: 0 })}
                        </Text>
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
          ))}
          <View style={[styles.totalRow, { borderTopColor: colors.border }]}>
            <Text style={[styles.totalLabel, { color: colors.mutedForeground }]}>Total {title.toLowerCase()}</Text>
            <Text style={[styles.totalValue, { color: toneColor }]}>
              {formatCurrency(total, ccy, { decimals: 0 })}
            </Text>
          </View>
        </View>
      )}
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
  rangeLabel: { fontSize: 13, fontWeight: "600" },
  rangeNote: { fontSize: 12, marginTop: 2, marginBottom: 14, lineHeight: 17 },
  nwCard: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 16 },
  nwLabel: { fontSize: 13, fontWeight: "600" },
  nwValue: { fontSize: 30, fontWeight: "800", fontVariant: ["tabular-nums"], marginTop: 2 },
  nwSplit: { flexDirection: "row", marginTop: 14, gap: 28 },
  nwSplitLabel: { fontSize: 12 },
  nwSplitVal: { fontSize: 16, fontWeight: "700", fontVariant: ["tabular-nums"], marginTop: 2 },
  sectionTitle: { fontSize: 16, fontWeight: "700", marginBottom: 10 },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  groupRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 12, paddingVertical: 11 },
  groupName: { flex: 1, fontSize: 12, fontWeight: "700", letterSpacing: 0.4, marginRight: 10 },
  groupTotal: { fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] },
  acctRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
    paddingLeft: 24,
    paddingRight: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  acctName: { flex: 1, fontSize: 14, fontWeight: "500", marginRight: 10 },
  acctVal: { fontSize: 14, fontWeight: "600", fontVariant: ["tabular-nums"] },
  acctNative: { fontSize: 11, marginTop: 1, fontVariant: ["tabular-nums"] },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 13,
    borderTopWidth: 1,
  },
  totalLabel: { fontSize: 13, fontWeight: "700" },
  totalValue: { fontSize: 15, fontWeight: "800", fontVariant: ["tabular-nums"] },
  empty: { fontSize: 14, paddingVertical: 16 },
  error: { fontSize: 14, textAlign: "center", paddingVertical: 32 },
});
