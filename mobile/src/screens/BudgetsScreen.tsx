import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  View,
  Text,
  ScrollView,
  TextInput,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { formatCurrency as formatCurrencyBase } from "../lib/format";
import { DISPLAY_CURRENCY_FALLBACK } from "../lib/constants";
import type { BudgetWithSpending, Category } from "../../../shared/types";
import type { MoreStackParamList } from "../navigation/MoreStack";

type Nav = NativeStackNavigationProp<MoreStackParamList, "Budgets">;

/**
 * "YYYY-MM" for the month `offset` months from `now`. Built from day 1 of the
 * month: `setMonth` on today's date overflows near month-end (Jan 31 + 1 month
 * = Mar 3), which made Next/Prev skip a month.
 */
export function monthFromOffset(offset: number, now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function formatMonthLabel(monthStr: string): string {
  const [year, month] = monthStr.split("-");
  const d = new Date(Number(year), Number(month) - 1);
  return d.toLocaleDateString("en-CA", { month: "long", year: "numeric" });
}

function formatCurrency(amount: number, currency: string): string {
  return formatCurrencyBase(amount, currency, { decimals: 0 });
}

export default function BudgetsScreen() {
  const theme = useTheme();
  const colors = theme.colors;
  const navigation = useNavigation<Nav>();
  const isFocused = useIsFocused();

  const [budgets, setBudgets] = useState<BudgetWithSpending[]>([]);
  // The month `budgets` belongs to. Rows are only rendered under a matching
  // month label, so a slow or failed fetch never shows another month's rows.
  const [loadedMonth, setLoadedMonth] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [fetchedDisplayCurrency, setFetchedDisplayCurrency] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [monthOffset, setMonthOffset] = useState(0);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editAmount, setEditAmount] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [newCategoryId, setNewCategoryId] = useState<number | null>(null);
  const [newAmount, setNewAmount] = useState("");
  const [saving, setSaving] = useState(false);

  const month = monthFromOffset(monthOffset);
  const monthRef = useRef(month);
  monthRef.current = month;
  const loadedMonthRef = useRef<string | null>(null);

  const fetchBudgets = useCallback(
    async (isRefresh = false) => {
      const target = month;
      if (isRefresh) setRefreshing(true);
      try {
        // Categories feed the add-budget picker and the display currency is
        // what a new budget is created in; neither failing should blank the
        // budget list, so they degrade to null.
        const [budgetRes, catRes, dcRes] = await Promise.all([
          endpoints.getBudgets(target),
          endpoints.getCategories().catch(() => null),
          endpoints.getDisplayCurrency().catch(() => null),
        ]);
        if (catRes?.success) setCategories(catRes.data ?? []);
        else if (catRes) logger.warn("budgets", "categories fetch failed", { error: catRes.error });
        if (dcRes?.success && dcRes.data?.displayCurrency) {
          setFetchedDisplayCurrency(dcRes.data.displayCurrency);
        }
        // The user moved to another month while this was in flight; the
        // newer fetch owns the screen.
        if (monthRef.current !== target) return;
        if (budgetRes.success) {
          setBudgets(Array.isArray(budgetRes.data) ? budgetRes.data : []);
          loadedMonthRef.current = target;
          setLoadedMonth(target);
          setError(null);
        } else {
          logger.warn("budgets", "budgets fetch failed", { error: budgetRes.error });
          failMonth(target, budgetRes.error);
        }
      } catch (e) {
        const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        logger.error("budgets", "fetch threw", { detail });
        if (monthRef.current === target) failMonth(target, "Cannot connect to server");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [month]
  );

  // A failed fetch for a different month must not leave the previous month's
  // rows on screen under the new label. A failed refresh of the SAME month
  // keeps what is already shown and just surfaces the error.
  function failMonth(target: string, message: string) {
    if (loadedMonthRef.current !== target) {
      setBudgets([]);
      loadedMonthRef.current = target;
      setLoadedMonth(target);
    }
    setError(message);
  }

  // Refetch on focus (e.g. back from a category drill-down or after editing
  // a category) and whenever the month changes.
  useEffect(() => {
    if (isFocused) fetchBudgets();
  }, [isFocused, fetchBudgets]);

  const monthLoading = loadedMonth !== month;
  const rows = monthLoading ? [] : budgets;

  // The server converts every amount into the display currency and says which
  // one on each row; the settings fetch covers a month with no rows yet.
  const displayCurrency =
    rows.find((b) => b.displayCurrency)?.displayCurrency ??
    fetchedDisplayCurrency ??
    DISPLAY_CURRENCY_FALLBACK;

  // `categoryName` is decrypted server-side. The categories-list lookup only
  // covers a server too old to send it.
  const categoryLabel = (b: BudgetWithSpending) =>
    b.categoryName ||
    categories.find((c) => c.id === b.categoryId)?.name ||
    `Category #${b.categoryId}`;

  const totalBudgeted = rows.reduce((s, b) => s + (b.convertedAmount ?? b.amount), 0);
  const totalSpent = rows.reduce((s, b) => s + (b.convertedSpent ?? 0), 0);
  const overallPct = totalBudgeted > 0 ? Math.min((totalSpent / totalBudgeted) * 100, 100) : 0;
  const totalOver = totalSpent > totalBudgeted;

  const goToMonth = (delta: number) => {
    setEditingId(null);
    setMonthOffset((p) => p + delta);
  };

  // Editing works in the DISPLAY currency (the field is prefilled with the
  // converted amount), so the save re-denominates the budget into it. Sending
  // the amount without `currency` would store a display-currency number
  // against the row's old currency.
  const handleSaveEdit = async (budget: BudgetWithSpending) => {
    if (saving) return;
    const parsedAmount = parseFloat(editAmount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      Alert.alert("Error", "Enter a valid amount");
      return;
    }
    setSaving(true);
    try {
      const res = await endpoints.saveBudget({
        categoryId: budget.categoryId,
        month: budget.month,
        amount: parsedAmount,
        currency: displayCurrency,
      });
      if (res.success) {
        setEditingId(null);
        fetchBudgets(true);
      } else {
        Alert.alert("Error", res.error || "Failed to update");
      }
    } catch {
      Alert.alert("Error", "Cannot connect to server");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (budget: BudgetWithSpending) => {
    Alert.alert("Delete Budget", `Remove budget for ${categoryLabel(budget)}?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            const res = await endpoints.deleteBudget(budget.id);
            if (!res.success) {
              Alert.alert("Couldn't delete", res.error || "Please try again.");
              return;
            }
            fetchBudgets(true);
          } catch {
            Alert.alert("Error", "Cannot connect to server");
          }
        },
      },
    ]);
  };

  const handleAddBudget = async () => {
    if (saving) return;
    if (!newCategoryId) {
      Alert.alert("Error", "Select a category");
      return;
    }
    const parsedAmount = parseFloat(newAmount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      Alert.alert("Error", "Enter a valid amount");
      return;
    }
    setSaving(true);
    try {
      const res = await endpoints.saveBudget({
        categoryId: newCategoryId,
        month,
        amount: parsedAmount,
        currency: displayCurrency,
      });
      if (res.success) {
        setShowAddForm(false);
        setNewAmount("");
        setNewCategoryId(null);
        fetchBudgets(true);
      } else {
        Alert.alert("Error", res.error || "Failed to create budget");
      }
    } catch {
      Alert.alert("Error", "Cannot connect to server");
    } finally {
      setSaving(false);
    }
  };

  // Categories not yet budgeted this month
  const budgetedCatIds = new Set(rows.map((b) => b.categoryId));
  const unbudgetedCats = categories.filter(
    (c) => c.type === "E" && !budgetedCatIds.has(c.id)
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
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => fetchBudgets(true)} />
        }
      >
        {/* Header */}
        <View style={styles.headerRow}>
          <Text style={[styles.header, { color: colors.foreground }]}>Budgets</Text>
          <TouchableOpacity
            style={[styles.addSmallBtn, { backgroundColor: colors.primary }]}
            onPress={() => setShowAddForm(!showAddForm)}
          >
            <Text style={[styles.addSmallBtnText, { color: colors.primaryForeground }]}>
              {showAddForm ? "✕" : "+ Add"}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Month Navigator */}
        <View style={styles.monthNav}>
          <TouchableOpacity onPress={() => goToMonth(-1)}>
            <Text style={[styles.navBtn, { color: colors.primary }]}>← Prev</Text>
          </TouchableOpacity>
          <Text style={[styles.monthLabel, { color: colors.foreground }]}>
            {formatMonthLabel(month)}
          </Text>
          <TouchableOpacity onPress={() => goToMonth(1)}>
            <Text style={[styles.navBtn, { color: colors.primary }]}>Next →</Text>
          </TouchableOpacity>
        </View>

        {monthLoading && (
          <View style={styles.monthLoading}>
            <ActivityIndicator size="small" color={colors.primary} />
          </View>
        )}

        {!monthLoading && error && (
          <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text>
        )}

        {/* Overall Summary */}
        {rows.length > 0 && (
          <View
            style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <View style={styles.summaryRow}>
              <View>
                <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>Spent</Text>
                <Text style={[styles.summaryValue, { color: colors.foreground }]}>
                  {formatCurrency(totalSpent, displayCurrency)}
                </Text>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>
                  Budgeted
                </Text>
                <Text style={[styles.summaryValue, { color: colors.primary }]}>
                  {formatCurrency(totalBudgeted, displayCurrency)}
                </Text>
              </View>
            </View>
            <View style={[styles.overallBar, { backgroundColor: colors.secondary }]}>
              <View
                style={[
                  styles.overallFill,
                  {
                    backgroundColor: totalOver ? colors.destructive : colors.primary,
                    width: `${overallPct}%`,
                  },
                ]}
              />
            </View>
            <Text
              style={[
                styles.remainText,
                { color: totalOver ? colors.destructive : colors.mutedForeground },
              ]}
            >
              {totalOver
                ? `${formatCurrency(totalSpent - totalBudgeted, displayCurrency)} over`
                : `${formatCurrency(totalBudgeted - totalSpent, displayCurrency)} remaining`}
            </Text>
          </View>
        )}

        {/* Add Budget Form */}
        {showAddForm && (
          <View
            style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>New Budget</Text>
            <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>CATEGORY</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
              {unbudgetedCats.map((cat) => (
                <TouchableOpacity
                  key={cat.id}
                  onPress={() => setNewCategoryId(cat.id)}
                  style={[
                    styles.chip,
                    {
                      backgroundColor:
                        cat.id === newCategoryId ? colors.primary : colors.secondary,
                      borderColor: colors.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.chipText,
                      {
                        color:
                          cat.id === newCategoryId
                            ? colors.primaryForeground
                            : colors.foreground,
                      },
                    ]}
                    numberOfLines={1}
                  >
                    {cat.name}
                  </Text>
                </TouchableOpacity>
              ))}
              {unbudgetedCats.length === 0 && (
                <Text style={[styles.noCats, { color: colors.mutedForeground }]}>
                  All expense categories have budgets
                </Text>
              )}
            </ScrollView>
            <Text style={[styles.fieldLabel, { color: colors.mutedForeground, marginTop: 12 }]}>
              AMOUNT ({displayCurrency})
            </Text>
            <TextInput
              style={[
                styles.amountInput,
                {
                  color: colors.foreground,
                  backgroundColor: colors.secondary,
                  borderColor: colors.border,
                },
              ]}
              value={newAmount}
              onChangeText={setNewAmount}
              keyboardType="decimal-pad"
              placeholder="0"
              placeholderTextColor={colors.mutedForeground}
            />
            <TouchableOpacity
              style={[styles.saveBtn, { backgroundColor: colors.primary, opacity: saving ? 0.6 : 1 }]}
              onPress={handleAddBudget}
              disabled={saving}
            >
              <Text style={[styles.saveBtnText, { color: colors.primaryForeground }]}>
                Add Budget
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Budget List */}
        {!monthLoading && rows.length === 0 && !error && (
          <View style={styles.emptyContainer}>
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              No budgets set for {formatMonthLabel(month)}
            </Text>
          </View>
        )}

        {rows.map((b) => {
          const budgetAmt = b.convertedAmount ?? b.amount;
          const spent = b.convertedSpent ?? 0;
          const pct = budgetAmt > 0 ? Math.min((spent / budgetAmt) * 100, 100) : 0;
          const isOver = spent > budgetAmt;
          const isEditing = editingId === b.id;
          const name = categoryLabel(b);
          const storedInOtherCurrency = !!b.currency && b.currency !== displayCurrency;

          return (
            <TouchableOpacity
              key={b.id}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`${name} budget`}
              onPress={
                isEditing
                  ? undefined
                  : () =>
                      navigation.navigate("CategoryDetail", { categoryId: b.categoryId, name })
              }
              onLongPress={() => {
                Alert.alert(name, undefined, [
                  {
                    text: "Edit Amount",
                    onPress: () => {
                      setEditingId(b.id);
                      setEditAmount(String(Math.round(budgetAmt * 100) / 100));
                    },
                  },
                  { text: "Delete", style: "destructive", onPress: () => handleDelete(b) },
                  { text: "Cancel", style: "cancel" },
                ]);
              }}
            >
              <View
                style={[
                  styles.budgetCard,
                  { backgroundColor: colors.card, borderColor: colors.border },
                ]}
              >
                <View style={styles.budgetHeader}>
                  <Text style={[styles.catName, { color: colors.foreground }]} numberOfLines={1}>
                    {name}
                  </Text>
                  {b.categoryGroup && (
                    <Text style={[styles.catGroup, { color: colors.mutedForeground }]}>
                      {b.categoryGroup}
                    </Text>
                  )}
                </View>

                {isEditing ? (
                  <>
                    <View style={styles.editRow}>
                      <Text style={[styles.editCurrency, { color: colors.mutedForeground }]}>
                        {displayCurrency}
                      </Text>
                      <TextInput
                        style={[
                          styles.editInput,
                          {
                            color: colors.foreground,
                            backgroundColor: colors.secondary,
                            borderColor: colors.border,
                          },
                        ]}
                        value={editAmount}
                        onChangeText={setEditAmount}
                        keyboardType="decimal-pad"
                        autoFocus
                      />
                      <TouchableOpacity
                        style={[
                          styles.editSaveBtn,
                          { backgroundColor: colors.primary, opacity: saving ? 0.6 : 1 },
                        ]}
                        onPress={() => handleSaveEdit(b)}
                        disabled={saving}
                      >
                        <Text style={{ color: colors.primaryForeground, fontWeight: "600" }}>
                          Save
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => setEditingId(null)} disabled={saving}>
                        <Text style={{ color: colors.mutedForeground, fontSize: 14 }}>Cancel</Text>
                      </TouchableOpacity>
                    </View>
                    {storedInOtherCurrency && (
                      <Text style={[styles.editNote, { color: colors.mutedForeground }]}>
                        This budget is set in {b.currency} (
                        {formatCurrencyBase(b.amount, b.currency, { decimals: 2 })}). Saving
                        stores it in {displayCurrency}.
                      </Text>
                    )}
                  </>
                ) : (
                  <>
                    <View style={styles.amountsRow}>
                      <Text style={[styles.spentText, { color: colors.foreground }]}>
                        {formatCurrency(spent, displayCurrency)}
                      </Text>
                      <Text style={[styles.ofText, { color: colors.mutedForeground }]}>
                        {" "}
                        of {formatCurrency(budgetAmt, displayCurrency)}
                      </Text>
                    </View>
                    <View style={[styles.progressBar, { backgroundColor: colors.secondary }]}>
                      <View
                        style={[
                          styles.progressFill,
                          {
                            backgroundColor: isOver ? colors.destructive : colors.primary,
                            width: `${pct}%`,
                          },
                        ]}
                      />
                    </View>
                    <Text
                      style={[
                        styles.remaining,
                        { color: isOver ? colors.destructive : colors.mutedForeground },
                      ]}
                    >
                      {isOver
                        ? `${formatCurrency(spent - budgetAmt, displayCurrency)} over budget`
                        : `${formatCurrency(budgetAmt - spent, displayCurrency)} remaining`}
                    </Text>
                  </>
                )}
              </View>
            </TouchableOpacity>
          );
        })}

        {rows.length > 0 && (
          <Text style={[styles.hintText, { color: colors.mutedForeground }]}>
            Tap a budget to see its spending · long press to edit or delete
          </Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  scroll: { padding: 16, paddingBottom: 32 },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  header: { fontSize: 28, fontWeight: "800" },
  addSmallBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  addSmallBtnText: { fontSize: 14, fontWeight: "700" },
  monthNav: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
    paddingVertical: 8,
  },
  navBtn: { fontSize: 14, fontWeight: "600" },
  monthLabel: { fontSize: 17, fontWeight: "700" },
  monthLoading: { paddingVertical: 24, alignItems: "center" },
  errorText: { fontSize: 14, marginBottom: 12 },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    marginBottom: 12,
  },
  cardTitle: { fontSize: 16, fontWeight: "700", marginBottom: 8 },
  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  summaryLabel: { fontSize: 12, marginBottom: 2 },
  summaryValue: { fontSize: 22, fontWeight: "800" },
  overallBar: { height: 8, borderRadius: 4, overflow: "hidden", marginBottom: 8 },
  overallFill: { height: 8, borderRadius: 4 },
  remainText: { fontSize: 12, textAlign: "center" },
  emptyContainer: { paddingVertical: 32, alignItems: "center" },
  emptyText: { fontSize: 14 },
  budgetCard: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    marginBottom: 8,
  },
  budgetHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  catName: { fontSize: 15, fontWeight: "600", flex: 1 },
  catGroup: { fontSize: 12 },
  amountsRow: { flexDirection: "row", alignItems: "baseline", marginBottom: 6 },
  spentText: { fontSize: 16, fontWeight: "700" },
  ofText: { fontSize: 13 },
  progressBar: { height: 6, borderRadius: 3, overflow: "hidden", marginBottom: 4 },
  progressFill: { height: 6, borderRadius: 3 },
  remaining: { fontSize: 12 },
  editRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  editCurrency: { fontSize: 13, fontWeight: "600" },
  editInput: {
    flex: 1,
    fontSize: 16,
    fontWeight: "600",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  editSaveBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  editNote: { fontSize: 12, marginTop: 6 },
  fieldLabel: { fontSize: 12, fontWeight: "600", marginBottom: 6 },
  chipRow: { flexDirection: "row" },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    marginRight: 8,
  },
  chipText: { fontSize: 13, fontWeight: "500" },
  noCats: { fontSize: 13, paddingVertical: 4 },
  amountInput: {
    fontSize: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12,
  },
  saveBtn: { borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  saveBtnText: { fontSize: 15, fontWeight: "700" },
  hintText: { fontSize: 11, textAlign: "center", marginTop: 4 },
});
