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
import type { DashboardData, HealthScoreData, BudgetWithSpending } from "../../../shared/types";

function formatCurrency(amount: number, currency = "CAD"): string {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

function getCurrentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function getHealthColor(score: number): string {
  if (score >= 70) return "#10b981";
  if (score >= 40) return "#f59e0b";
  return "#ef4444";
}

function HealthScoreRing({ score, grade, color }: { score: number; grade: string; color: string }) {
  // Simple ring visualization using nested Views
  const size = 100;
  const strokeWidth = 8;
  const pct = Math.min(score, 100);

  return (
    <View style={healthStyles.container}>
      {/* Background ring */}
      <View
        style={[
          healthStyles.ring,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            borderWidth: strokeWidth,
            borderColor: color + "22",
          },
        ]}
      >
        {/* Filled overlay — we approximate a progress arc with a half-circle technique */}
        <View
          style={[
            healthStyles.ring,
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              borderWidth: strokeWidth,
              borderColor: color,
              borderTopColor: pct > 75 ? color : "transparent",
              borderRightColor: pct > 50 ? color : "transparent",
              borderBottomColor: pct > 25 ? color : "transparent",
              borderLeftColor: color,
              position: "absolute",
            },
          ]}
        />
        <View style={healthStyles.inner}>
          <Text style={[healthStyles.score, { color }]}>{score}</Text>
          <Text style={[healthStyles.grade, { color }]}>{grade}</Text>
        </View>
      </View>
    </View>
  );
}

function BudgetProgressBar({
  label,
  spent,
  budget,
  colors,
}: {
  label: string;
  spent: number;
  budget: number;
  colors: ReturnType<typeof useTheme>["colors"];
}) {
  const pct = budget > 0 ? Math.min((spent / budget) * 100, 100) : 0;
  const isOver = spent > budget;

  return (
    <View style={budgetStyles.item}>
      <View style={budgetStyles.labelRow}>
        <Text style={[budgetStyles.name, { color: colors.foreground }]} numberOfLines={1}>
          {label}
        </Text>
        <Text style={[budgetStyles.amounts, { color: colors.mutedForeground }]}>
          {formatCurrency(spent)} / {formatCurrency(budget)}
        </Text>
      </View>
      <View style={[budgetStyles.bar, { backgroundColor: colors.secondary }]}>
        <View
          style={[
            budgetStyles.fill,
            {
              backgroundColor: isOver ? colors.destructive : colors.primary,
              width: `${pct}%`,
            },
          ]}
        />
      </View>
    </View>
  );
}

export default function DashboardScreen() {
  const theme = useTheme();
  const [data, setData] = useState<DashboardData | null>(null);
  const [health, setHealth] = useState<HealthScoreData | null>(null);
  const [budgets, setBudgets] = useState<BudgetWithSpending[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const [dashRes, healthRes, budgetRes] = await Promise.all([
        endpoints.getDashboard(),
        endpoints.getHealthScore(),
        endpoints.getBudgets(getCurrentMonth()),
      ]);

      if (dashRes.success) {
        setData(dashRes.data);
        setError(null);
      } else {
        setError(dashRes.error);
      }

      if (healthRes.success) setHealth(healthRes.data);
      if (budgetRes.success) setBudgets(budgetRes.data);
    } catch {
      setError("Cannot connect to server");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchAll();
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

  const healthColor = health ? getHealthColor(health.score) : colors.primary;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => fetchAll(true)} />
        }
      >
        <Text style={[styles.header, { color: colors.foreground }]}>Dashboard</Text>

        {/* Net Worth + Health Score Row */}
        <View style={styles.heroRow}>
          {/* Net Worth Card */}
          <View
            style={[
              styles.card,
              styles.heroCard,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
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
                <Text style={[styles.smallLabel, { color: colors.mutedForeground }]}>
                  Liabilities
                </Text>
                <Text style={[styles.smallValue, { color: colors.destructive }]}>
                  {data ? formatCurrency(data.totalLiabilities) : "--"}
                </Text>
              </View>
            </View>
          </View>

          {/* Health Score Card */}
          {health && (
            <View
              style={[
                styles.card,
                styles.healthCard,
                { backgroundColor: colors.card, borderColor: colors.border },
              ]}
            >
              <Text style={[styles.cardLabel, { color: colors.mutedForeground }]}>
                Health Score
              </Text>
              <HealthScoreRing score={health.score} grade={health.grade} color={healthColor} />
            </View>
          )}
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

        {/* Budget Progress Summary */}
        {budgets.length > 0 && (
          <View
            style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <Text style={[styles.cardLabel, { color: colors.mutedForeground }]}>
              Budget Progress
            </Text>
            {budgets.slice(0, 5).map((b) => (
              <BudgetProgressBar
                key={b.id}
                label={b.categoryName || `Category ${b.categoryId}`}
                spent={b.convertedSpent ?? 0}
                budget={b.convertedAmount ?? b.amount}
                colors={colors}
              />
            ))}
            {budgets.length > 5 && (
              <Text style={[styles.moreText, { color: colors.mutedForeground }]}>
                +{budgets.length - 5} more budgets
              </Text>
            )}
          </View>
        )}

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
  heroRow: { flexDirection: "row", gap: 12, marginBottom: 12 },
  heroCard: { flex: 1, marginBottom: 0 },
  healthCard: { width: 140, marginBottom: 0, alignItems: "center" },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    marginBottom: 12,
  },
  cardLabel: { fontSize: 13, fontWeight: "600", marginBottom: 4 },
  cardValue: { fontSize: 28, fontWeight: "800", marginBottom: 12 },
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
  moreText: { fontSize: 12, textAlign: "center", marginTop: 8 },
});

const healthStyles = StyleSheet.create({
  container: { alignItems: "center", marginTop: 4 },
  ring: { alignItems: "center", justifyContent: "center" },
  inner: { alignItems: "center" },
  score: { fontSize: 28, fontWeight: "800" },
  grade: { fontSize: 11, fontWeight: "600" },
});

const budgetStyles = StyleSheet.create({
  item: { marginTop: 10 },
  labelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  name: { fontSize: 13, fontWeight: "500", flex: 1, marginRight: 8 },
  amounts: { fontSize: 11 },
  bar: { height: 6, borderRadius: 3, overflow: "hidden" },
  fill: { height: 6, borderRadius: 3 },
});
