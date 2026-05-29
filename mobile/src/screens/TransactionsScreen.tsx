import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  FlatList,
  TextInput,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { formatCurrency, safeName, formatShortDate } from "../lib/format";
import type { Transaction } from "../../../shared/types";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { TransactionsStackParamList } from "../navigation/TransactionsStack";
import { useIsFocused } from "@react-navigation/native";

type Props = NativeStackScreenProps<TransactionsStackParamList, "TransactionsList">;

export default function TransactionsScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const isFocused = useIsFocused();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const fetchTransactions = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      try {
        // Mirror AccountDetailScreen's recognized sort params (the backend reads
        // `sort`/`sortDir`, not `order`). No accountId → all of the user's rows.
        const params = new URLSearchParams();
        params.set("limit", "50");
        params.set("sort", "date");
        params.set("sortDir", "desc");
        if (search.trim()) params.set("search", search.trim());
        const res = await endpoints.getTransactions(params.toString());
        if (res.success) {
          setTransactions(res.data);
          setError(null);
          // Count in the message string (the Diagnostics panel truncates the
          // data object) so an empty result is unambiguous on device.
          logger.info("transactions", `loaded ${res.data.length} rows`);
        } else {
          logger.warn("transactions", "fetch failed", { error: res.error });
          setError(res.error);
        }
      } catch (e) {
        const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        logger.error("transactions", "fetch threw", { detail });
        setError("Cannot connect to server");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [search]
  );

  useEffect(() => {
    if (isFocused) fetchTransactions();
  }, [isFocused, fetchTransactions]);

  const handleDelete = (tx: Transaction) => {
    Alert.alert(
      "Delete Transaction",
      `Delete "${safeName(tx.payee || tx.note, "this transaction")}"?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              const res = await endpoints.deleteTransaction(tx.id);
              if (res.success) {
                setTransactions((prev) => prev.filter((t) => t.id !== tx.id));
              }
            } catch {
              Alert.alert("Error", "Cannot connect to server");
            }
          },
        },
      ]
    );
  };

  const renderItem = ({ item }: { item: Transaction }) => {
    const positive = item.amount >= 0;
    const subtitle = item.categoryName
      ? `${formatShortDate(item.date)} · ${item.categoryName}`
      : formatShortDate(item.date);
    return (
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={() => navigation.navigate("TransactionDetail", { transaction: item })}
        onLongPress={() => {
          Alert.alert(safeName(item.payee || item.note, "Transaction"), formatCurrency(item.amount, item.currency), [
            {
              text: "Edit",
              onPress: () => navigation.navigate("TransactionDetail", { transaction: item }),
            },
            { text: "Delete", style: "destructive", onPress: () => handleDelete(item) },
            { text: "Cancel", style: "cancel" },
          ]);
        }}
      >
        <View style={[styles.row, { borderBottomColor: colors.border }]}>
          <View
            style={[
              styles.indicator,
              { backgroundColor: (positive ? colors.pos : colors.destructive) + "22" },
            ]}
          >
            <Text style={{ fontSize: 14, color: positive ? colors.pos : colors.destructive }}>
              {positive ? "↑" : "↓"}
            </Text>
          </View>
          <View style={styles.left}>
            <Text style={[styles.payee, { color: colors.foreground }]} numberOfLines={1}>
              {safeName(item.payee || item.note, "Transaction")}
            </Text>
            <Text style={[styles.date, { color: colors.mutedForeground }]} numberOfLines={1}>
              {subtitle}
            </Text>
          </View>
          <View style={styles.right}>
            <Text style={[styles.amount, { color: positive ? colors.pos : colors.foreground }]}>
              {formatCurrency(item.amount, item.currency)}
            </Text>
            <Text style={[styles.chevron, { color: colors.mutedForeground }]}>›</Text>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      {/* Header */}
      <View style={styles.headerRow}>
        <Text style={[styles.header, { color: colors.foreground }]}>Transactions</Text>
        <TouchableOpacity
          style={[styles.addBtn, { backgroundColor: colors.primary }]}
          onPress={() => navigation.navigate("AddTransaction")}
        >
          <Text style={[styles.addBtnText, { color: colors.primaryForeground }]}>+ Add</Text>
        </TouchableOpacity>
      </View>

      {/* Search Bar */}
      <View style={[styles.searchContainer, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.searchIcon, { color: colors.mutedForeground }]}>⌕</Text>
        <TextInput
          style={[styles.searchInput, { color: colors.foreground }]}
          value={search}
          onChangeText={setSearch}
          placeholder="Search transactions..."
          placeholderTextColor={colors.mutedForeground}
          returnKeyType="search"
          onSubmitEditing={() => fetchTransactions()}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => setSearch("")}>
            <Text style={[styles.clearBtn, { color: colors.mutedForeground }]}>✕</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Hint */}
      <Text style={[styles.hint, { color: colors.mutedForeground }]}>
        Tap to view • Long press for actions
      </Text>

      {/* The list is ALWAYS rendered with flex:1 (mirrors AccountDetailScreen).
          Loading/error/empty are handled by ListEmptyComponent so the FlatList
          never collapses to zero height behind a conditional. */}
      <FlatList
        style={styles.flatList}
        data={transactions}
        keyExtractor={(item) => String(item.id)}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => fetchTransactions(true)} />
        }
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator style={{ marginTop: 32 }} size="large" color={colors.primary} />
          ) : error ? (
            <Text style={[styles.empty, { color: colors.destructive }]}>{error}</Text>
          ) : (
            <Text style={[styles.empty, { color: colors.mutedForeground }]}>
              {search ? "No matching transactions" : "No transactions yet"}
            </Text>
          )
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flatList: { flex: 1 },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  header: { fontSize: 28, fontWeight: "800" },
  addBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  addBtnText: { fontSize: 14, fontWeight: "700" },
  searchContainer: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 16,
    marginBottom: 4,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    height: 40,
  },
  searchIcon: { fontSize: 16, marginRight: 8 },
  searchInput: { flex: 1, fontSize: 15, paddingVertical: 0 },
  clearBtn: { fontSize: 14, padding: 4 },
  hint: { fontSize: 11, textAlign: "center", marginBottom: 4 },
  list: { paddingHorizontal: 16, paddingBottom: 32 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  indicator: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  left: { flex: 1, marginRight: 12 },
  right: { flexDirection: "row", alignItems: "center", gap: 6 },
  payee: { fontSize: 15, fontWeight: "500" },
  date: { fontSize: 12, marginTop: 2 },
  amount: { fontSize: 15, fontWeight: "600", fontVariant: ["tabular-nums"] },
  chevron: { fontSize: 20, fontWeight: "300" },
  empty: { textAlign: "center", paddingVertical: 32, fontSize: 14 },
});
