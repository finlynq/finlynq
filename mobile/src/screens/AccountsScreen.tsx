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
import { formatCurrency } from "../lib/format";
import {
  parseGroupOrderResponse,
  parseDropdownOrder,
  EMPTY_DROPDOWN_ORDER,
  type AccountGroupOrder,
  type DropdownOrder,
} from "../lib/sort-helpers";
import { accountDisplayName, buildAccountSections, sumNetWorth } from "../lib/account-sections";
import { DEFAULT_DISPLAY_CURRENCY } from "../lib/dashboard";
import { Icon } from "../components/icon";
import type { AccountBalance } from "../../../shared/types";
import type { AccountsStackParamList } from "../navigation/AccountsStack";

type Props = NativeStackScreenProps<AccountsStackParamList, "AccountsList">;

export default function AccountsScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const isFocused = useIsFocused();
  // ALL balance rows, archived included: the net-worth total sums these; the
  // list itself hides archived rows unless "Show archived" is on.
  const [balances, setBalances] = useState<AccountBalance[]>([]);
  const [displayCurrency, setDisplayCurrency] = useState<string>(DEFAULT_DISPLAY_CURRENCY);
  const [groupOrder, setGroupOrder] = useState<AccountGroupOrder>({ A: [], L: [] });
  const [dropdownOrder, setDropdownOrder] = useState<DropdownOrder>(EMPTY_DROPDOWN_ORDER);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAccounts = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      // Fetch balances, saved group order, and the account dropdown order in
      // parallel. Both ordering fetches are non-fatal — a failure degrades to
      // alpha sections with "Other" last / plain name order.
      const [res, orderRes, dropdownRes] = await Promise.all([
        endpoints.getAccountsOverview(),
        endpoints.getAccountGroupOrder(),
        endpoints.getDropdownOrder(),
      ]);
      if (res.success) {
        setBalances(res.data.balances);
        setDisplayCurrency(res.data.displayCurrency || DEFAULT_DISPLAY_CURRENCY);
        setError(null);
      } else {
        logger.warn("accounts", "fetch failed", { error: res.error });
        setError(res.error);
      }
      if (orderRes.success) {
        // The route returns { order: {A,L} } — parseGroupOrderResponse unwraps
        // the envelope before parsing (mirrors web's parseGroupOrder(d.order)).
        // Passing the outer envelope would read .A/.L = undefined and silently
        // fall back to alpha.
        setGroupOrder(parseGroupOrderResponse(orderRes.data));
      } else {
        logger.warn("accounts", "group-order fetch failed — using fallback sort", {
          error: orderRes.error,
        });
      }
      if (dropdownRes.success) {
        // /api/settings/dropdown-order returns the DropdownOrder object directly
        // (no envelope) — no unwrap.
        setDropdownOrder(parseDropdownOrder(dropdownRes.data));
      } else {
        logger.warn("accounts", "dropdown-order fetch failed — using fallback sort", {
          error: dropdownRes.error,
        });
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

  // Archived accounts stay in net worth — archiving is a visibility flag only.
  const netWorth = sumNetWorth(balances);
  const archivedCount = balances.filter((b) => b.archived).length;
  const sections = buildAccountSections(balances, groupOrder, dropdownOrder, showArchived);

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
        <Text
          style={[styles.heroValue, { color: colors.foreground }]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.6}
        >
          {formatCurrency(netWorth, displayCurrency, { decimals: 0 })}
        </Text>
      </View>

      {error ? (
        <View style={styles.center}>
          <Text style={{ color: colors.destructive }}>{error}</Text>
          <TouchableOpacity
            style={[styles.retryBtn, { borderColor: colors.border }]}
            onPress={() => fetchAccounts()}
          >
            <Text style={[styles.retryText, { color: colors.primary }]}>Retry</Text>
          </TouchableOpacity>
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
            <View>
              {section.typeHeader && (
                <Text style={[styles.typeHeader, { color: colors.foreground }]}>
                  {section.typeHeader}
                </Text>
              )}
              <Text style={[styles.sectionHeader, { color: colors.mutedForeground }]}>
                {section.title}
              </Text>
            </View>
          )}
          renderItem={({ item }) => {
            // Big number = the account's NATIVE balance (sign drives the color).
            const valueColor =
              item.balance > 0 ? colors.pos : item.balance < 0 ? colors.neg : colors.foreground;
            // Grayed sub-line = the display-currency translation. Hide it when
            // there's nothing to convert (no rate) or the account is already in
            // the display currency (the two lines would be identical).
            const subCurrency = item.displayCurrency ?? displayCurrency;
            const showSub =
              item.convertedBalance != null && item.currency !== subCurrency;
            return (
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => navigation.navigate("AccountDetail", { account: item })}
                style={[
                  styles.row,
                  { backgroundColor: colors.card, borderColor: colors.border },
                  item.archived ? styles.rowArchived : null,
                ]}
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
                      {accountDisplayName(item)}
                    </Text>
                    <Text style={[styles.accountMeta, { color: colors.mutedForeground }]}>
                      {item.currency}
                      {item.archived ? " · Archived" : ""}
                    </Text>
                  </View>
                </View>
                <View style={styles.rowRight}>
                  <View style={styles.amountStack}>
                    <Text style={[styles.amount, { color: valueColor }]}>
                      {formatCurrency(item.balance, item.currency, { decimals: 0 })}
                    </Text>
                    {showSub && (
                      <Text style={[styles.amountSub, { color: colors.mutedForeground }]}>
                        {formatCurrency(item.convertedBalance!, subCurrency, { decimals: 0 })}
                      </Text>
                    )}
                  </View>
                  <Icon name="chevronRight" size={16} color={colors.mutedForeground} />
                </View>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <Text style={[styles.empty, { color: colors.mutedForeground }]}>
              {archivedCount > 0 ? "No active accounts" : "No accounts yet"}
            </Text>
          }
          ListFooterComponent={
            archivedCount > 0 ? (
              <TouchableOpacity
                style={styles.archivedToggle}
                onPress={() => setShowArchived((v) => !v)}
                accessibilityRole="button"
              >
                <Text style={[styles.archivedToggleText, { color: colors.mutedForeground }]}>
                  {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
                </Text>
              </TouchableOpacity>
            ) : null
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
  typeHeader: { fontSize: 17, fontWeight: "800", marginTop: 16, marginBottom: 2 },
  sectionHeader: {
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 10,
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
  rowArchived: { opacity: 0.6 },
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
  amountStack: { alignItems: "flex-end" },
  amount: { fontSize: 16, fontWeight: "700", fontVariant: ["tabular-nums"] },
  amountSub: { fontSize: 12, fontWeight: "600", marginTop: 2, fontVariant: ["tabular-nums"] },
  empty: { textAlign: "center", paddingVertical: 32, fontSize: 14 },
  archivedToggle: { alignSelf: "center", paddingVertical: 14, paddingHorizontal: 16 },
  archivedToggleText: { fontSize: 13, fontWeight: "600" },
  retryBtn: {
    marginTop: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  retryText: { fontSize: 14, fontWeight: "600" },
});
