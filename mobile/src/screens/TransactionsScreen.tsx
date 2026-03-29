import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import type { Transaction } from "../../../shared/types";

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    minimumFractionDigits: 2,
  }).format(amount);
}

export default function TransactionsScreen() {
  const theme = useTheme();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTransactions = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const res = await endpoints.getTransactions("limit=50&order=desc");
      if (res.success) {
        setTransactions(res.data);
        setError(null);
      } else {
        setError(res.error);
      }
    } catch {
      setError("Cannot connect to server");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchTransactions();
  }, [fetchTransactions]);

  const colors = theme.colors;

  const renderItem = ({ item }: { item: Transaction }) => (
    <View style={[styles.row, { borderBottomColor: colors.border }]}>
      <View style={styles.left}>
        <Text style={[styles.payee, { color: colors.foreground }]} numberOfLines={1}>
          {item.payee || item.note || "Transaction"}
        </Text>
        <Text style={[styles.date, { color: colors.mutedForeground }]}>{item.date}</Text>
      </View>
      <Text
        style={[
          styles.amount,
          { color: item.amount >= 0 ? colors.chart3 : colors.foreground },
        ]}
      >
        {formatCurrency(item.amount)}
      </Text>
    </View>
  );

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <Text style={[styles.header, { color: colors.foreground }]}>Transactions</Text>
      {error ? (
        <View style={styles.center}>
          <Text style={{ color: colors.destructive }}>{error}</Text>
        </View>
      ) : (
        <FlatList
          data={transactions}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => fetchTransactions(true)} />
          }
          ListEmptyComponent={
            <Text style={[styles.empty, { color: colors.mutedForeground }]}>
              No transactions yet
            </Text>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: { fontSize: 28, fontWeight: "800", paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  list: { paddingHorizontal: 16, paddingBottom: 32 },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  left: { flex: 1, marginRight: 12 },
  payee: { fontSize: 15, fontWeight: "500" },
  date: { fontSize: 12, marginTop: 2 },
  amount: { fontSize: 15, fontWeight: "600" },
  empty: { textAlign: "center", paddingVertical: 32, fontSize: 14 },
});
