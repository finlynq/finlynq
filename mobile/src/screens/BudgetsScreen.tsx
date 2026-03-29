import React, { useEffect, useState, useCallback } from "react";
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
import type { Budget } from "../../../shared/types";

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

export default function BudgetsScreen() {
  const theme = useTheme();
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchBudgets = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const res = await endpoints.getBudgets(currentMonth());
      if (res.success) {
        setBudgets(res.data);
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
    fetchBudgets();
  }, [fetchBudgets]);

  const colors = theme.colors;

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => fetchBudgets(true)} />
        }
      >
        <Text style={[styles.header, { color: colors.foreground }]}>Budgets</Text>
        <Text style={[styles.month, { color: colors.mutedForeground }]}>{currentMonth()}</Text>

        {error && (
          <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text>
        )}

        {budgets.length === 0 && !error && (
          <View style={styles.emptyContainer}>
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              No budgets set for this month
            </Text>
          </View>
        )}

        {budgets.map((b) => (
          <View
            key={b.id}
            style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <View style={styles.cardRow}>
              <Text style={[styles.catName, { color: colors.foreground }]}>
                Category #{b.categoryId}
              </Text>
              <Text style={[styles.budgetAmt, { color: colors.primary }]}>
                {formatCurrency(b.amount)}
              </Text>
            </View>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  scroll: { padding: 16, paddingBottom: 32 },
  header: { fontSize: 28, fontWeight: "800" },
  month: { fontSize: 14, fontWeight: "500", marginBottom: 16 },
  errorText: { fontSize: 14, marginBottom: 12 },
  emptyContainer: { paddingVertical: 32, alignItems: "center" },
  emptyText: { fontSize: 14 },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    marginBottom: 8,
  },
  cardRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  catName: { fontSize: 15, fontWeight: "500" },
  budgetAmt: { fontSize: 16, fontWeight: "700" },
});
