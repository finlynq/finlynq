import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import type { DashboardData } from "../../../shared/types";

function formatCurrency(amount: number, currency = "CAD"): string {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

export default function DashboardScreen() {
  const theme = useTheme();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDashboard = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const res = await endpoints.getDashboard();
      if (res.success) {
        setData(res.data);
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
  };

  useEffect(() => {
    fetchDashboard();
  }, []);

  const colors = theme.colors;

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Text style={{ color: colors.destructive, fontSize: 15 }}>{error}</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => fetchDashboard(true)} />
        }
      >
        <Text style={[styles.header, { color: colors.foreground }]}>Dashboard</Text>

        {/* Net Worth Card */}
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.cardLabel, { color: colors.mutedForeground }]}>Net Worth</Text>
          <Text style={[styles.cardValue, { color: colors.foreground }]}>
            {data ? formatCurrency(data.netWorth) : "--"}
          </Text>
          <View style={styles.row}>
            <View style={styles.halfCol}>
              <Text style={[styles.smallLabel, { color: colors.mutedForeground }]}>Assets</Text>
              <Text style={[styles.smallValue, { color: colors.chart3 }]}>
                {data ? formatCurrency(data.totalAssets) : "--"}
              </Text>
            </View>
            <View style={styles.halfCol}>
              <Text style={[styles.smallLabel, { color: colors.mutedForeground }]}>Liabilities</Text>
              <Text style={[styles.smallValue, { color: colors.destructive }]}>
                {data ? formatCurrency(data.totalLiabilities) : "--"}
              </Text>
            </View>
          </View>
        </View>

        {/* Monthly Summary */}
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.cardLabel, { color: colors.mutedForeground }]}>This Month</Text>
          <View style={styles.row}>
            <View style={styles.halfCol}>
              <Text style={[styles.smallLabel, { color: colors.mutedForeground }]}>Income</Text>
              <Text style={[styles.smallValue, { color: colors.chart3 }]}>
                {data ? formatCurrency(data.monthlyIncome) : "--"}
              </Text>
            </View>
            <View style={styles.halfCol}>
              <Text style={[styles.smallLabel, { color: colors.mutedForeground }]}>Expenses</Text>
              <Text style={[styles.smallValue, { color: colors.destructive }]}>
                {data ? formatCurrency(data.monthlyExpenses) : "--"}
              </Text>
            </View>
          </View>
          {data && data.savingsRate > 0 && (
            <View style={[styles.savingsBar, { backgroundColor: colors.secondary }]}>
              <View
                style={[
                  styles.savingsFill,
                  {
                    backgroundColor: colors.primary,
                    width: `${Math.min(data.savingsRate, 100)}%`,
                  },
                ]}
              />
              <Text style={[styles.savingsText, { color: colors.mutedForeground }]}>
                {data.savingsRate.toFixed(0)}% savings rate
              </Text>
            </View>
          )}
        </View>

        {/* Recent Transactions */}
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.cardLabel, { color: colors.mutedForeground }]}>
            Recent Transactions
          </Text>
          {data?.recentTransactions?.slice(0, 5).map((tx) => (
            <View key={tx.id} style={[styles.txRow, { borderBottomColor: colors.border }]}>
              <View style={styles.txLeft}>
                <Text style={[styles.txPayee, { color: colors.foreground }]}>
                  {tx.payee || tx.note || "Transaction"}
                </Text>
                <Text style={[styles.txDate, { color: colors.mutedForeground }]}>{tx.date}</Text>
              </View>
              <Text
                style={[
                  styles.txAmount,
                  { color: tx.amount >= 0 ? colors.chart3 : colors.foreground },
                ]}
              >
                {formatCurrency(tx.amount)}
              </Text>
            </View>
          ))}
          {(!data?.recentTransactions || data.recentTransactions.length === 0) && (
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              No recent transactions
            </Text>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  scroll: { padding: 16, paddingBottom: 32 },
  header: { fontSize: 28, fontWeight: "800", marginBottom: 16 },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    marginBottom: 12,
  },
  cardLabel: { fontSize: 13, fontWeight: "600", marginBottom: 4 },
  cardValue: { fontSize: 32, fontWeight: "800", marginBottom: 12 },
  row: { flexDirection: "row", gap: 12 },
  halfCol: { flex: 1 },
  smallLabel: { fontSize: 12, marginBottom: 2 },
  smallValue: { fontSize: 18, fontWeight: "700" },
  savingsBar: {
    height: 24,
    borderRadius: 12,
    marginTop: 12,
    overflow: "hidden",
    justifyContent: "center",
  },
  savingsFill: { position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: 12 },
  savingsText: { fontSize: 11, fontWeight: "600", textAlign: "center" },
  txRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  txLeft: { flex: 1, marginRight: 12 },
  txPayee: { fontSize: 14, fontWeight: "500" },
  txDate: { fontSize: 12, marginTop: 2 },
  txAmount: { fontSize: 15, fontWeight: "600" },
  emptyText: { fontSize: 14, textAlign: "center", paddingVertical: 16 },
});
