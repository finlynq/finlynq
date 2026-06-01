import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  SectionList,
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
import type { AccountBalance } from "../../../shared/types";
import type { AccountsStackParamList } from "../navigation/AccountsStack";

type Props = NativeStackScreenProps<AccountsStackParamList, "AccountsList">;

interface Section {
  title: string;
  data: AccountBalance[];
}

function groupAccounts(balances: AccountBalance[]): Section[] {
  const groups = new Map<string, AccountBalance[]>();
  for (const b of balances) {
    const key = b.accountGroup || "Other";
    const arr = groups.get(key) ?? [];
    arr.push(b);
    groups.set(key, arr);
  }
  return Array.from(groups.entries())
    .map(([title, data]) => ({
      title,
      data: data.sort((a, z) =>
        safeName(a.accountName).localeCompare(safeName(z.accountName))
      ),
    }))
    .sort((a, z) => a.title.localeCompare(z.title));
}

export default function AccountsScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const isFocused = useIsFocused();
  const [balances, setBalances] = useState<AccountBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAccounts = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const res = await endpoints.getAccountBalances();
      if (res.success) {
        setBalances(res.data);
        setError(null);
      } else {
        logger.warn("accounts", "fetch failed", { error: res.error });
        setError(res.error);
      }
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error("accounts", "fetch threw", { detail });
      setError("Cannot connect to server");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (isFocused) fetchAccounts();
  }, [isFocused, fetchAccounts]);

  const displayCurrency = balances[0]?.displayCurrency ?? "CAD";
  const netWorth = balances.reduce((s, b) => s + (b.convertedBalance ?? b.balance), 0);
  const sections = groupAccounts(balances);

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={styles.headerRow}>
        <Text style={[styles.header, { color: colors.foreground }]}>Accounts</Text>
        <TouchableOpacity
          style={[styles.addSmallBtn, { backgroundColor: colors.primary }]}
          onPress={() => navigation.navigate("AddAccount")}
        >
          <Text style={[styles.addSmallBtnText, { color: colors.primaryForeground }]}>+ Add</Text>
        </TouchableOpacity>
      </View>

      {/* Net worth hero */}
      <View style={[styles.hero, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.heroLabel, { color: colors.mutedForeground }]}>Net Worth</Text>
        <Text style={[styles.heroValue, { color: colors.foreground }]}>
          {formatCurrency(netWorth, displayCurrency, { decimals: 0 })}
        </Text>
      </View>

      {error ? (
        <View style={styles.center}>
          <Text style={{ color: colors.destructive }}>{error}</Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => String(item.accountId)}
          contentContainerStyle={styles.list}
          stickySectionHeadersEnabled={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => fetchAccounts(true)} />
          }
          renderSectionHeader={({ section }) => (
            <Text style={[styles.sectionHeader, { color: colors.mutedForeground }]}>
              {section.title}
            </Text>
          )}
          renderItem={({ item }) => {
            const value = item.convertedBalance ?? item.balance;
            const valueColor =
              value > 0 ? colors.pos : value < 0 ? colors.neg : colors.foreground;
            return (
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => navigation.navigate("AccountDetail", { account: item })}
                style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border }]}
              >
                <View style={styles.rowLeft}>
                  <View style={[styles.iconWrap, { backgroundColor: colors.secondary }]}>
                    <Icon
                      name={item.isInvestment ? "portfolio" : item.accountType === "L" ? "bank" : "accounts"}
                      size={18}
                      color={colors.mutedForeground}
                    />
                  </View>
                  <View style={styles.rowText}>
                    <Text style={[styles.accountName, { color: colors.foreground }]} numberOfLines={1}>
                      {safeName(item.accountName)}
                    </Text>
                    <Text style={[styles.accountMeta, { color: colors.mutedForeground }]}>
                      {item.currency}
                      {item.accountType === "L" ? " · Liability" : ""}
                    </Text>
                  </View>
                </View>
                <View style={styles.rowRight}>
                  <Text style={[styles.amount, { color: valueColor }]}>
                    {formatCurrency(value, item.displayCurrency ?? displayCurrency, { decimals: 0 })}
                  </Text>
                  <Icon name="chevronRight" size={16} color={colors.mutedForeground} />
                </View>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <Text style={[styles.empty, { color: colors.mutedForeground }]}>No accounts yet</Text>
          }
        />
      )}
    </SafeAreaView>
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
  addSmallBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  addSmallBtnText: { fontSize: 14, fontWeight: "700" },
  hero: {
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
  },
  heroLabel: { fontSize: 13, fontWeight: "600", marginBottom: 4 },
  heroValue: { fontSize: 30, fontWeight: "800", fontVariant: ["tabular-nums"] },
  list: { paddingHorizontal: 16, paddingBottom: 32 },
  sectionHeader: {
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 12,
    marginBottom: 6,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    marginBottom: 8,
  },
  rowLeft: { flexDirection: "row", alignItems: "center", flex: 1, marginRight: 12 },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  rowText: { flex: 1 },
  accountName: { fontSize: 15, fontWeight: "600" },
  accountMeta: { fontSize: 12, marginTop: 2 },
  rowRight: { flexDirection: "row", alignItems: "center", gap: 4 },
  amount: { fontSize: 16, fontWeight: "700", fontVariant: ["tabular-nums"] },
  empty: { textAlign: "center", paddingVertical: 32, fontSize: 14 },
});
