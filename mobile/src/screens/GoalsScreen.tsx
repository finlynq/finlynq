import React, { useCallback, useEffect, useState } from "react";
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
import { Icon } from "../components/icon";
import type { GoalWithProgress } from "../../../shared/types";
import type { MoreStackParamList } from "../navigation/MoreStack";

type Nav = NativeStackNavigationProp<MoreStackParamList, "Goals">;

const TYPE_LABEL: Record<string, string> = {
  savings: "Savings",
  debt_payoff: "Debt payoff",
  investment: "Investment",
  emergency_fund: "Emergency fund",
};

export default function GoalsScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation<Nav>();
  const isFocused = useIsFocused();
  const [goals, setGoals] = useState<GoalWithProgress[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchGoals = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const res = await endpoints.getGoals();
      if (res.success) {
        setGoals(res.data);
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

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const renderGoal = ({ item }: { item: GoalWithProgress }) => {
    const currency = item.currency ?? "CAD";
    const pct = Math.max(0, Math.min(item.progress ?? 0, 100));
    const isDebt = item.type === "debt_payoff";
    const reached = pct >= 100;
    return (
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
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

        <View style={styles.amounts}>
          <Text style={[styles.current, { color: colors.foreground }]}>
            {formatCurrency(item.currentAmount ?? 0, currency, { decimals: 0 })}
            <Text style={{ color: colors.mutedForeground }}>
              {" "}
              {isDebt ? "paid" : "saved"} of{" "}
              {formatCurrency(item.targetAmount, currency, { decimals: 0 })}
            </Text>
          </Text>
        </View>
        {(item.remaining ?? 0) > 0 && (
          <Text style={[styles.remaining, { color: colors.mutedForeground }]}>
            {formatCurrency(item.remaining, currency, { decimals: 0 })}{" "}
            {isDebt ? "remaining to pay off" : "to go"}
          </Text>
        )}
      </View>
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
        data={goals}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => fetchGoals(true)} />
        }
        renderItem={renderGoal}
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
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    marginBottom: 10,
  },
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
