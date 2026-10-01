import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
  TouchableOpacity,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { formatCurrency, safeName } from "../lib/format";
import { DISPLAY_CURRENCY_FALLBACK } from "../lib/constants";
import { Icon } from "../components/icon";
import type { GoalWithProgress } from "../../../shared/types";
import type { MoreStackParamList } from "../navigation/MoreStack";

type Nav = NativeStackNavigationProp<MoreStackParamList, "Goals">;

/** One flat list drives the screen: an optional error banner, the active
 *  goals, then a "Completed" header + the completed goals. */
type Row =
  | { kind: "goal"; goal: GoalWithProgress }
  | { kind: "header"; title: string }
  | { kind: "error"; message: string };

const TYPE_LABEL: Record<string, string> = {
  savings: "Savings",
  debt_payoff: "Debt payoff",
  investment: "Investment",
  emergency_fund: "Emergency fund",
};

/**
 * Active vs completed, mirroring the web goals page. Anything not explicitly
 * "completed" stays in the active list, so a goal with an unexpected status is
 * never hidden.
 */
export function splitGoalsByStatus(goals: GoalWithProgress[]): {
  active: GoalWithProgress[];
  completed: GoalWithProgress[];
} {
  const active: GoalWithProgress[] = [];
  const completed: GoalWithProgress[] = [];
  for (const g of goals) (g.status === "completed" ? completed : active).push(g);
  return { active, completed };
}

export default function GoalsScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation<Nav>();
  const isFocused = useIsFocused();
  const [goals, setGoals] = useState<GoalWithProgress[]>([]);
  // Full-screen spinner only until the first response; focus refetches after
  // that update the list in place.
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [displayCurrency, setDisplayCurrency] = useState(DISPLAY_CURRENCY_FALLBACK);

  const fetchGoals = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const res = await endpoints.getGoals();
      if (res.success) {
        setGoals(Array.isArray(res.data) ? res.data : []);
        setError(null);
      } else {
        logger.warn("goals", "fetch failed", { error: res.error });
        setError(res.error);
      }
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error("goals", "fetch threw", { detail });
      setError("Cannot connect to server");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (isFocused) fetchGoals();
  }, [isFocused, fetchGoals]);

  // Only used to label a legacy goal stored without a currency.
  useEffect(() => {
    endpoints
      .getDisplayCurrency()
      .then((r) => {
        if (r.success && r.data?.displayCurrency) setDisplayCurrency(r.data.displayCurrency);
      })
      .catch(() => {});
  }, []);

  const rows = useMemo<Row[]>(() => {
    if (goals.length === 0) return []; // ListEmptyComponent covers error + empty
    const { active, completed } = splitGoalsByStatus(goals);
    const out: Row[] = [];
    // A failed reload is shown even when goals are already listed (the list
    // keeps the last good data underneath).
    if (error) out.push({ kind: "error", message: error });
    for (const g of active) out.push({ kind: "goal", goal: g });
    if (completed.length > 0) {
      out.push({ kind: "header", title: `COMPLETED (${completed.length})` });
      for (const g of completed) out.push({ kind: "goal", goal: g });
    }
    return out;
  }, [goals, error]);

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const renderGoal = (item: GoalWithProgress) => {
    const currency = item.currency || displayCurrency;
    const pct = Math.max(0, Math.min(item.progress ?? 0, 100));
    const isDebt = item.type === "debt_payoff";
    const isCompleted = item.status === "completed";
    const reached = pct >= 100;
    const current = item.currentAmount ?? 0;
    return (
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={() => navigation.navigate("AddGoal", { goal: item })}
        style={[
          styles.card,
          { backgroundColor: colors.card, borderColor: colors.border },
          isCompleted && styles.cardCompleted,
        ]}
      >
        <View style={styles.cardTop}>
          <View style={[styles.iconWrap, { backgroundColor: colors.secondary }]}>
            <Icon name="goals" size={18} color={colors.primary} />
          </View>
          <View style={styles.cardText}>
            <Text style={[styles.goalName, { color: colors.foreground }]} numberOfLines={1}>
              {safeName(item.name)}
            </Text>
            <Text style={[styles.goalType, { color: colors.mutedForeground }]}>
              {TYPE_LABEL[item.type] ?? item.type}
              {isCompleted ? " · Completed" : ""}
            </Text>
          </View>
          <Text
            style={[styles.pct, { color: reached ? colors.pos : colors.foreground }]}
          >
            {pct.toFixed(0)}%
          </Text>
        </View>

        <View style={[styles.track, { backgroundColor: colors.secondary }]}>
          <View
            style={[
              styles.fill,
              { backgroundColor: reached ? colors.pos : colors.primary, width: `${pct}%` },
            ]}
          />
        </View>

        {isDebt ? (
          // The server's currentAmount for a debt goal is the plain sum of the
          // linked accounts' balances (a liability reads negative), NOT an
          // amount paid off — so show it neutrally as a balance, and don't
          // derive a "remaining to pay off" from it.
          <View style={styles.amounts}>
            <Text style={[styles.current, { color: colors.foreground }]}>
              {formatCurrency(current, currency, { decimals: 0 })}
              <Text style={{ color: colors.mutedForeground }}> current balance</Text>
            </Text>
            <Text style={[styles.remaining, { color: colors.mutedForeground }]}>
              Target {formatCurrency(item.targetAmount, currency, { decimals: 0 })}
            </Text>
          </View>
        ) : (
          <>
            <View style={styles.amounts}>
              <Text style={[styles.current, { color: colors.foreground }]}>
                {formatCurrency(current, currency, { decimals: 0 })}
                <Text style={{ color: colors.mutedForeground }}>
                  {" "}
                  saved of {formatCurrency(item.targetAmount, currency, { decimals: 0 })}
                </Text>
              </Text>
            </View>
            {!isCompleted && (item.remaining ?? 0) > 0 && (
              <Text style={[styles.remaining, { color: colors.mutedForeground }]}>
                {formatCurrency(item.remaining, currency, { decimals: 0 })} to go
              </Text>
            )}
          </>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={styles.headerRow}>
        <Text style={[styles.header, { color: colors.foreground }]}>Goals</Text>
        <TouchableOpacity
          style={[styles.addSmallBtn, { backgroundColor: colors.primary }]}
          onPress={() => navigation.navigate("AddGoal")}
        >
          <Text style={[styles.addSmallBtnText, { color: colors.primaryForeground }]}>+ Add</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={rows}
        keyExtractor={(row) =>
          row.kind === "goal" ? `goal-${row.goal.id}` : row.kind
        }
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => fetchGoals(true)} />
        }
        renderItem={({ item: row }) =>
          row.kind === "goal" ? (
            renderGoal(row.goal)
          ) : row.kind === "header" ? (
            <Text style={[styles.sectionHeader, { color: colors.mutedForeground }]}>
              {row.title}
            </Text>
          ) : (
            <Text style={[styles.errorBanner, { color: colors.destructive }]}>
              {row.message}
            </Text>
          )
        }
        ListEmptyComponent={
          error ? (
            <Text style={[styles.empty, { color: colors.destructive }]}>{error}</Text>
          ) : (
            <View style={styles.emptyWrap}>
              <Text style={[styles.empty, { color: colors.mutedForeground }]}>
                No goals yet.
              </Text>
              <TouchableOpacity
                style={[styles.ctaBtn, { backgroundColor: colors.primary }]}
                onPress={() => navigation.navigate("AddGoal")}
              >
                <Text style={[styles.ctaBtnText, { color: colors.primaryForeground }]}>
                  + Add your first goal
                </Text>
              </TouchableOpacity>
            </View>
          )
        }
      />
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
  list: { paddingHorizontal: 16, paddingBottom: 32 },
  sectionHeader: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.5,
    marginTop: 12,
    marginBottom: 8,
  },
  errorBanner: { fontSize: 14, marginBottom: 10 },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    marginBottom: 10,
  },
  cardCompleted: { opacity: 0.75 },
  cardTop: { flexDirection: "row", alignItems: "center", marginBottom: 12 },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  cardText: { flex: 1, marginRight: 8 },
  goalName: { fontSize: 15, fontWeight: "600" },
  goalType: { fontSize: 12, marginTop: 2 },
  pct: { fontSize: 18, fontWeight: "800", fontVariant: ["tabular-nums"] },
  track: { height: 8, borderRadius: 4, overflow: "hidden", marginBottom: 8 },
  fill: { height: 8, borderRadius: 4 },
  amounts: {},
  current: { fontSize: 14, fontWeight: "700", fontVariant: ["tabular-nums"] },
  remaining: { fontSize: 12, marginTop: 4 },
  empty: { textAlign: "center", paddingVertical: 32, fontSize: 14 },
  emptyWrap: { alignItems: "center", paddingVertical: 24 },
  ctaBtn: { paddingHorizontal: 20, paddingVertical: 12, borderRadius: 10 },
  ctaBtnText: { fontSize: 15, fontWeight: "700" },
});
