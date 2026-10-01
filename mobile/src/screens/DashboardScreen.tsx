import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
  TouchableOpacity,
  Dimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  useIsFocused,
  useNavigation,
  type NavigatorScreenParams,
} from "@react-navigation/native";
import { useTheme, type ThemeColors } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { formatCurrency, safeName } from "../lib/format";
import {
  DEFAULT_DISPLAY_CURRENCY,
  formatMonthLabel,
  monthKey,
  resolveSavingsRate,
  sortBudgetsByRisk,
} from "../lib/dashboard";
import type {
  ApiResponse,
  DashboardData,
  HealthScoreData,
  BudgetWithSpending,
  Transaction,
} from "../../../shared/types";
import type { MoreStackParamList } from "../navigation/MoreStack";
import type { TransactionsStackParamList } from "../navigation/TransactionsStack";

/** Summary tiles use whole units; transaction rows keep cents. */
function formatWhole(amount: number, currency: string): string {
  return formatCurrency(amount, currency, { decimals: 0 });
}

/** Below this window width the health card moves to its own row so the
 *  Net Worth / Assets / Liabilities figures get the full card width. */
const NARROW_WIDTH = 400;

const BUDGET_PREVIEW_COUNT = 5;

// Palette-aligned via theme tokens (light AND dark): teal (good) / amber
// (fair) / coral (needs work).
function getHealthColor(score: number, colors: ThemeColors): string {
  if (score >= 70) return colors.pos;
  if (score >= 40) return colors.primary;
  return colors.destructive;
}

// The Home tab is a direct tab screen; it deep-links into the More and
// Transactions stacks. TabParamList types Transactions as `undefined`, so a
// minimal typed cast keeps this off `any`.
type DashboardNav = {
  navigate: {
    (tab: "More", params: NavigatorScreenParams<MoreStackParamList>): void;
    (tab: "Transactions", params: NavigatorScreenParams<TransactionsStackParamList>): void;
  };
};

/** Never let one rejected request take the other dashboard fetches down with it. */
function settle<T>(p: Promise<ApiResponse<T>>): Promise<ApiResponse<T>> {
  return p.catch((e: unknown) => {
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    logger.error("dashboard", "request threw", { detail });
    return { success: false as const, error: "Cannot connect to server" };
  });
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
  currency,
  colors,
}: {
  label: string;
  spent: number;
  budget: number;
  currency: string;
  colors: ThemeColors;
}) {
  const pct = budget > 0 ? Math.min((spent / budget) * 100, 100) : 0;
  const isOver = spent > budget;

  return (
    <View style={budgetStyles.item}>
      <View style={budgetStyles.labelRow}>
        <Text style={[budgetStyles.name, { color: colors.foreground }]} numberOfLines={1}>
          {label}
        </Text>
        <Text
          style={[
            budgetStyles.amounts,
            { color: isOver ? colors.destructive : colors.mutedForeground },
          ]}
        >
          {formatWhole(spent, currency)} / {formatWhole(budget, currency)}
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
  const { colors } = useTheme();
  const isFocused = useIsFocused();
  const navigation = useNavigation() as unknown as DashboardNav;
  // Same convention as TrendBars / CategoryDetailScreen (the jest RN mock
  // stubs Dimensions, not useWindowDimensions).
  const narrow = Dimensions.get("window").width < NARROW_WIDTH;

  const [data, setData] = useState<DashboardData | null>(null);
  const [health, setHealth] = useState<HealthScoreData | null>(null);
  const [budgets, setBudgets] = useState<BudgetWithSpending[]>([]);
  // True only until the FIRST load settles; later refetches (focus, pull) keep
  // the last good data on screen instead of flashing a full-screen spinner.
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Drop responses from a superseded fetch (focus refetch racing a pull).
  const fetchSeq = useRef(0);

  const fetchAll = useCallback(async (isRefresh = false) => {
    const seq = ++fetchSeq.current;
    if (isRefresh) setRefreshing(true);
    try {
      const [dashRes, healthRes, budgetRes] = await Promise.all([
        settle(endpoints.getDashboard()),
        settle(endpoints.getHealthScore()),
        settle(endpoints.getBudgets(monthKey())),
      ]);
      if (seq !== fetchSeq.current) return;

      if (dashRes.success) {
        setData(dashRes.data);
        setError(null);
      } else {
        // Keep the last good data (if any) — the error renders as a banner.
        logger.warn("dashboard", "dashboard fetch failed", { error: dashRes.error });
        setError(dashRes.error || "Couldn't load your dashboard");
      }
      if (healthRes.success) setHealth(healthRes.data);
      else logger.warn("dashboard", "health-score fetch failed", { error: healthRes.error });
      if (budgetRes.success) setBudgets(budgetRes.data);
      else logger.warn("dashboard", "budgets fetch failed", { error: budgetRes.error });
    } finally {
      if (seq === fetchSeq.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  // Refetch every time Home regains focus — a transaction added on another tab
  // must show up here without a manual pull.
  useEffect(() => {
    if (isFocused) fetchAll();
  }, [isFocused, fetchAll]);

  if (loading && !data) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const currency = data?.displayCurrency || DEFAULT_DISPLAY_CURRENCY;
  const healthColor = health ? getHealthColor(health.score, colors) : colors.primary;
  const monthTitle = data?.referenceMonth ? formatMonthLabel(data.referenceMonth) : "This Month";
  const savings = resolveSavingsRate(health, data);
  const sortedBudgets = sortBudgetsByRisk(budgets);
  const budgetCurrency =
    (budgets[0] as (BudgetWithSpending & { displayCurrency?: string }) | undefined)
      ?.displayCurrency || currency;

  const goTo = {
    categoryReports: (type: "E" | "I") =>
      navigation.navigate("More", { screen: "CategoryReports", params: { type }, initial: false }),
    budgets: () => navigation.navigate("More", { screen: "Budgets", initial: false }),
    transaction: (transaction: Transaction) =>
      navigation.navigate("Transactions", {
        screen: "TransactionDetail",
        params: { transaction },
        initial: false,
      }),
  };

  const errorBanner = error ? (
    <View
      style={[styles.banner, { backgroundColor: colors.card, borderColor: colors.destructive }]}
    >
      <Text style={[styles.bannerText, { color: colors.destructive }]}>
        {data ? `${error} — showing your last loaded data.` : error}
      </Text>
      <TouchableOpacity
        style={[styles.retryBtn, { borderColor: colors.border }]}
        onPress={() => fetchAll(true)}
        accessibilityRole="button"
      >
        <Text style={[styles.retryText, { color: colors.primary }]}>Retry</Text>
      </TouchableOpacity>
    </View>
  ) : null;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => fetchAll(true)} />
        }
      >
        <Text style={[styles.header, { color: colors.foreground }]}>Dashboard</Text>

        {errorBanner}

        {data && (
          <>
            {/* Net Worth + Health Score Row (stacked on narrow phones) */}
            <View style={narrow ? styles.heroColumn : styles.heroRow}>
              {/* Net Worth Card */}
              <View
                style={[
                  styles.card,
                  narrow ? styles.heroCardNarrow : styles.heroCard,
                  { backgroundColor: colors.card, borderColor: colors.border },
                ]}
              >
                <Text style={[styles.cardLabel, { color: colors.mutedForeground }]}>Net Worth</Text>
                <Text
                  style={[styles.cardValue, { color: colors.foreground }]}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.5}
                >
                  {formatWhole(data.netWorth, currency)}
                </Text>
                <View style={styles.row}>
                  <View style={styles.halfCol}>
                    <Text style={[styles.smallLabel, { color: colors.mutedForeground }]}>Assets</Text>
                    <Text
                      style={[styles.smallValue, { color: colors.pos }]}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.5}
                    >
                      {formatWhole(data.totalAssets, currency)}
                    </Text>
                  </View>
                  <View style={styles.halfCol}>
                    <Text style={[styles.smallLabel, { color: colors.mutedForeground }]}>
                      Liabilities
                    </Text>
                    <Text
                      style={[styles.smallValue, { color: colors.destructive }]}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.5}
                    >
                      {formatWhole(data.totalLiabilities, currency)}
                    </Text>
                  </View>
                </View>
              </View>

              {/* Health Score Card */}
              {health && (
                <View
                  style={[
                    styles.card,
                    narrow ? styles.healthCardNarrow : styles.healthCard,
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

            {/* Monthly Summary — the last COMPLETE month, named explicitly */}
            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.cardLabel, { color: colors.mutedForeground }]}>{monthTitle}</Text>
              <View style={styles.row}>
                <TouchableOpacity
                  style={styles.halfCol}
                  activeOpacity={0.7}
                  onPress={() => goTo.categoryReports("I")}
                  accessibilityRole="button"
                  accessibilityLabel="Income by category"
                >
                  <Text style={[styles.smallLabel, { color: colors.mutedForeground }]}>Income ›</Text>
                  <Text
                    style={[styles.smallValue, { color: colors.pos }]}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    minimumFontScale={0.5}
                  >
                    {formatWhole(data.monthlyIncome, currency)}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.halfCol}
                  activeOpacity={0.7}
                  onPress={() => goTo.categoryReports("E")}
                  accessibilityRole="button"
                  accessibilityLabel="Expenses by category"
                >
                  <Text style={[styles.smallLabel, { color: colors.mutedForeground }]}>Expenses ›</Text>
                  <Text
                    style={[styles.smallValue, { color: colors.destructive }]}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    minimumFontScale={0.5}
                  >
                    {formatWhole(data.monthlyExpenses, currency)}
                  </Text>
                </TouchableOpacity>
              </View>
              {savings && (
                <View style={[styles.savingsBar, { backgroundColor: colors.secondary }]}>
                  <View
                    style={[
                      styles.savingsFill,
                      {
                        backgroundColor: colors.primary,
                        width: `${Math.max(0, Math.min(savings.pct, 100))}%`,
                      },
                    ]}
                  />
                  <Text
                    style={[
                      styles.savingsText,
                      { color: savings.pct < 0 ? colors.destructive : colors.mutedForeground },
                    ]}
                  >
                    {savings.pct}% savings rate · {savings.period}
                  </Text>
                </View>
              )}
            </View>

            {/* Budget Progress Summary — most at-risk first */}
            {sortedBudgets.length > 0 && (
              <TouchableOpacity
                activeOpacity={0.8}
                onPress={goTo.budgets}
                accessibilityRole="button"
                style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
              >
                <View style={styles.cardHeaderRow}>
                  <Text style={[styles.cardLabel, { color: colors.mutedForeground }]}>
                    Budget Progress
                  </Text>
                  <Text style={[styles.linkText, { color: colors.primary }]}>See all ›</Text>
                </View>
                {sortedBudgets.slice(0, BUDGET_PREVIEW_COUNT).map((b) => (
                  <BudgetProgressBar
                    key={b.id}
                    label={safeName(b.categoryName, `Category #${b.categoryId}`)}
                    spent={b.convertedSpent ?? 0}
                    budget={b.convertedAmount ?? b.amount}
                    currency={budgetCurrency}
                    colors={colors}
                  />
                ))}
                {sortedBudgets.length > BUDGET_PREVIEW_COUNT && (
                  <Text style={[styles.moreText, { color: colors.mutedForeground }]}>
                    +{sortedBudgets.length - BUDGET_PREVIEW_COUNT} more budgets
                  </Text>
                )}
              </TouchableOpacity>
            )}

            {/* Recent Transactions */}
            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.cardLabel, { color: colors.mutedForeground }]}>
                Recent Transactions
              </Text>
              {data.recentTransactions?.slice(0, 5).map((tx) => (
                <TouchableOpacity
                  key={tx.id}
                  activeOpacity={0.7}
                  onPress={() => goTo.transaction(tx)}
                  style={[styles.txRow, { borderBottomColor: colors.border }]}
                >
                  <View style={styles.txLeft}>
                    <Text style={[styles.txPayee, { color: colors.foreground }]} numberOfLines={1}>
                      {safeName(tx.payee || tx.note, "Transaction")}
                    </Text>
                    <Text style={[styles.txDate, { color: colors.mutedForeground }]}>{tx.date}</Text>
                  </View>
                  <Text
                    style={[
                      styles.txAmount,
                      { color: tx.amount >= 0 ? colors.pos : colors.foreground },
                    ]}
                  >
                    {/* Each row in its OWN currency, with cents. */}
                    {formatCurrency(tx.amount, tx.currency || currency)}
                  </Text>
                </TouchableOpacity>
              ))}
              {(!data.recentTransactions || data.recentTransactions.length === 0) && (
                <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                  No recent transactions
                </Text>
              )}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  scroll: { padding: 16, paddingBottom: 32, flexGrow: 1 },
  header: { fontSize: 28, fontWeight: "800", marginBottom: 16 },
  heroRow: { flexDirection: "row", gap: 12, marginBottom: 12 },
  heroColumn: { flexDirection: "column", gap: 12, marginBottom: 12 },
  heroCard: { flex: 1, marginBottom: 0 },
  heroCardNarrow: { marginBottom: 0 },
  healthCard: { width: 140, marginBottom: 0, alignItems: "center" },
  healthCardNarrow: { marginBottom: 0, alignItems: "center" },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    marginBottom: 12,
  },
  cardHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  linkText: { fontSize: 12, fontWeight: "600" },
  cardLabel: { fontSize: 13, fontWeight: "600", marginBottom: 4 },
  cardValue: { fontSize: 28, fontWeight: "800", marginBottom: 12, fontVariant: ["tabular-nums"] },
  row: { flexDirection: "row", gap: 12 },
  halfCol: { flex: 1 },
  smallLabel: { fontSize: 12, marginBottom: 2 },
  smallValue: { fontSize: 18, fontWeight: "700", fontVariant: ["tabular-nums"] },
  savingsBar: {
    height: 24,
    borderRadius: 12,
    marginTop: 12,
    overflow: "hidden",
    justifyContent: "center",
  },
  savingsFill: { position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: 12 },
  savingsText: { fontSize: 11, fontWeight: "600", textAlign: "center" },
  banner: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    marginBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  bannerText: { flex: 1, fontSize: 13, lineHeight: 18 },
  retryBtn: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  retryText: { fontSize: 13, fontWeight: "700" },
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
  txAmount: { fontSize: 15, fontWeight: "600", fontVariant: ["tabular-nums"] },
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
