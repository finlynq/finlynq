import React, { useEffect, useState, useCallback } from "react";
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
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { api } from "../api/client";
import type { BudgetWithSpending, Category } from "../../../shared/types";

function getMonth(offset: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function formatMonthLabel(monthStr: string): string {
  const [year, month] = monthStr.split("-");
  const d = new Date(Number(year), Number(month) - 1);
  return d.toLocaleDateString("en-CA", { month: "long", year: "numeric" });
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
  const colors = theme.colors;

  const [budgets, setBudgets] = useState<BudgetWithSpending[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [monthOffset, setMonthOffset] = useState(0);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editAmount, setEditAmount] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [newCategoryId, setNewCategoryId] = useState<number | null>(null);
  const [newAmount, setNewAmount] = useState("");

  const month = getMonth(monthOffset);

  const fetchBudgets = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      try {
        const [budgetRes, catRes] = await Promise.all([
          endpoints.getBudgets(month),
          endpoints.getCategories(),
        ]);
        if (budgetRes.success) {
          setBudgets(budgetRes.data);
          setError(null);
        } else {
          setError(budgetRes.error);
        }
        if (catRes.success) setCategories(catRes.data);
      } catch {
        setError("Cannot connect to server");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [month]
  );

  useEffect(() => {
    fetchBudgets();
  }, [fetchBudgets]);

  const totalBudgeted = budgets.reduce((s, b) => s + (b.convertedAmount ?? b.amount), 0);
  const totalSpent = budgets.reduce((s, b) => s + (b.convertedSpent ?? 0), 0);
  const overallPct = totalBudgeted > 0 ? Math.min((totalSpent / totalBudgeted) * 100, 100) : 0;

  const handleSaveEdit = async (budget: BudgetWithSpending) => {
    const parsedAmount = parseFloat(editAmount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      Alert.alert("Error", "Enter a valid amount");
      return;
    }
    try {
      const res = await api.post("/api/budgets", {
        categoryId: budget.categoryId,
        month: budget.month,
        amount: parsedAmount,
      });
      if (res.success) {
        setEditingId(null);
        fetchBudgets(true);
      } else {
        Alert.alert("Error", "error" in res ? res.error : "Failed to update");
      }
    } catch {
      Alert.alert("Error", "Cannot connect to server");
    }
  };

  const handleDelete = (budget: BudgetWithSpending) => {
    Alert.alert("Delete Budget", `Remove budget for ${budget.categoryName || "this category"}?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await api.delete(`/api/budgets?id=${budget.id}`);
            fetchBudgets(true);
          } catch {
            Alert.alert("Error", "Cannot connect to server");
          }
        },
      },
    ]);
  };

  const handleAddBudget = async () => {
    if (!newCategoryId) {
      Alert.alert("Error", "Select a category");
      return;
    }
    const parsedAmount = parseFloat(newAmount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      Alert.alert("Error", "Enter a valid amount");
      return;
    }
    try {
      const res = await api.post("/api/budgets", {
        categoryId: newCategoryId,
        month,
        amount: parsedAmount,
      });
      if (res.success) {
        setShowAddForm(false);
        setNewAmount("");
        setNewCategoryId(null);
        fetchBudgets(true);
      } else {
        Alert.alert("Error", "error" in res ? res.error : "Failed to create budget");
      }
    } catch {
      Alert.alert("Error", "Cannot connect to server");
    }
  };

  // Categories not yet budgeted this month
  const budgetedCatIds = new Set(budgets.map((b) => b.categoryId));
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
          <TouchableOpacity onPress={() => setMonthOffset((p) => p - 1)}>
            <Text style={[styles.navBtn, { color: colors.primary }]}>← Prev</Text>
          </TouchableOpacity>
          <Text style={[styles.monthLabel, { color: colors.foreground }]}>
            {formatMonthLabel(month)}
          </Text>
          <TouchableOpacity onPress={() => setMonthOffset((p) => p + 1)}>
            <Text style={[styles.navBtn, { color: colors.primary }]}>Next →</Text>
          </TouchableOpacity>
        </View>

        {error && (
          <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text>
        )}

        {/* Overall Summary */}
        {budgets.length > 0 && (
          <View
            style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <View style={styles.summaryRow}>
              <View>
                <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>Spent</Text>
                <Text style={[styles.summaryValue, { color: colors.foreground }]}>
                  {formatCurrency(totalSpent)}
                </Text>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>
                  Budgeted
                </Text>
                <Text style={[styles.summaryValue, { color: colors.primary }]}>
                  {formatCurrency(totalBudgeted)}
                </Text>
              </View>
            </View>
            <View style={[styles.overallBar, { backgroundColor: colors.secondary }]}>
              <View
                style={[
                  styles.overallFill,
                  {
                    backgroundColor: totalSpent > totalBudgeted ? colors.destructive : colors.primary,
                    width: `${overallPct}%`,
                  },
                ]}
              />
            </View>
            <Text style={[styles.remainText, { color: colors.mutedForeground }]}>
              {formatCurrency(totalBudgeted - totalSpent)} remaining
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
              AMOUNT
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
              style={[styles.saveBtn, { backgroundColor: colors.primary }]}
              onPress={handleAddBudget}
            >
              <Text style={[styles.saveBtnText, { color: colors.primaryForeground }]}>
                Add Budget
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Budget List */}
        {budgets.length === 0 && !error && (
          <View style={styles.emptyContainer}>
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              No budgets set for {formatMonthLabel(month)}
            </Text>
          </View>
        )}

        {budgets.map((b) => {
          const budgetAmt = b.convertedAmount ?? b.amount;
          const spent = b.convertedSpent ?? 0;
          const pct = budgetAmt > 0 ? Math.min((spent / budgetAmt) * 100, 100) : 0;
          const isOver = spent > budgetAmt;
          const isEditing = editingId === b.id;

          return (
            <TouchableOpacity
              key={b.id}
              activeOpacity={0.7}
              onLongPress={() => {
                Alert.alert(b.categoryName || `Category #${b.categoryId}`, undefined, [
                  {
                    text: "Edit Amount",
                    onPress: () => {
                      setEditingId(b.id);
                      setEditAmount(String(budgetAmt));
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
                    {b.categoryName || `Category #${b.categoryId}`}
                  </Text>
                  {b.categoryGroup && (
                    <Text style={[styles.catGroup, { color: colors.mutedForeground }]}>
                      {b.categoryGroup}
                    </Text>
                  )}
                </View>

                {isEditing ? (
                  <View style={styles.editRow}>
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
                      style={[styles.editSaveBtn, { backgroundColor: colors.primary }]}
                      onPress={() => handleSaveEdit(b)}
                    >
                      <Text style={{ color: colors.primaryForeground, fontWeight: "600" }}>
                        Save
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => setEditingId(null)}>
                      <Text style={{ color: colors.mutedForeground, fontSize: 14 }}>Cancel</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <>
                    <View style={styles.amountsRow}>
                      <Text style={[styles.spentText, { color: colors.foreground }]}>
                        {formatCurrency(spent)}
                      </Text>
                      <Text style={[styles.ofText, { color: colors.mutedForeground }]}>
                        {" "}
                        of {formatCurrency(budgetAmt)}
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
                        ? `${formatCurrency(spent - budgetAmt)} over budget`
                        : `${formatCurrency(budgetAmt - spent)} remaining`}
                    </Text>
                  </>
                )}
              </View>
            </TouchableOpacity>
          );
        })}

        {budgets.length > 0 && (
          <Text style={[styles.hintText, { color: colors.mutedForeground }]}>
            Long press a budget to edit or delete
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
