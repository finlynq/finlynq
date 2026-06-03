import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { formatCurrency as formatCurrencyBase } from "../lib/format";
import { Icon } from "../components/icon";
import type { Transaction, Account, Category } from "../../../shared/types";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { TransactionsStackParamList } from "../navigation/TransactionsStack";

type Props = NativeStackScreenProps<TransactionsStackParamList, "TransactionDetail">;

function formatCurrency(amount: number, currency = "USD"): string {
  return formatCurrencyBase(amount, currency);
}

export default function TransactionDetailScreen({ route, navigation }: Props) {
  const theme = useTheme();
  const { transaction } = route.params;
  const colors = theme.colors;

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [splitCount, setSplitCount] = useState(0);

  // Editable fields
  const [date, setDate] = useState(transaction.date);
  const [amount, setAmount] = useState(String(transaction.amount));
  const [payee, setPayee] = useState(transaction.payee || "");
  const [note, setNote] = useState(transaction.note || "");
  const [tags, setTags] = useState(transaction.tags || "");
  const [selectedAccountId, setSelectedAccountId] = useState(transaction.accountId);
  const [selectedCategoryId, setSelectedCategoryId] = useState(transaction.categoryId);

  useEffect(() => {
    Promise.all([endpoints.getAccounts(), endpoints.getCategories()])
      .then(([accRes, catRes]) => {
        if (accRes.success) setAccounts(accRes.data);
        else logger.warn("tx-detail", "accounts fetch failed", { error: accRes.error });
        if (catRes.success) setCategories(catRes.data);
        else logger.warn("tx-detail", "categories fetch failed", { error: catRes.error });
      })
      .catch((e) => {
        const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        logger.error("tx-detail", "load threw", { detail });
      });
  }, []);

  // Lazy-fetch the split count for the "Split · N" chip. Refresh on focus so
  // it reflects edits made in the SplitsEditor screen after returning here.
  const refreshSplitCount = useCallback(() => {
    endpoints
      .getSplits(transaction.id)
      .then((res) => {
        if (res.success && Array.isArray(res.data)) setSplitCount(res.data.length);
      })
      .catch(() => {});
  }, [transaction.id]);

  useEffect(() => {
    refreshSplitCount();
    const unsub = navigation.addListener("focus", refreshSplitCount);
    return unsub;
  }, [navigation, refreshSplitCount]);

  const handleSplit = () => {
    navigation.navigate("SplitsEditor", {
      transactionId: transaction.id,
      totalAmount: transaction.amount,
      currency: transaction.currency,
    });
  };

  const accountName =
    accounts.find((a) => a.id === selectedAccountId)?.name ??
    (selectedAccountId ? `Account #${selectedAccountId}` : "—");
  const categoryName =
    categories.find((c) => c.id === selectedCategoryId)?.name ??
    (selectedCategoryId ? `Category #${selectedCategoryId}` : "—");

  const handleSave = async () => {
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount)) {
      Alert.alert("Error", "Please enter a valid amount");
      return;
    }
    setSaving(true);
    try {
      const res = await endpoints.updateTransaction({
        id: transaction.id,
        date,
        amount: parsedAmount,
        accountId: selectedAccountId!,
        categoryId: selectedCategoryId!,
        payee: payee || undefined,
        note: note || undefined,
        tags: tags || undefined,
      });
      if (res.success) {
        logger.info("tx-detail", "transaction updated", { id: transaction.id });
        setEditing(false);
        navigation.goBack();
      } else {
        logger.warn("tx-detail", "update rejected", { id: transaction.id, error: res.error });
        Alert.alert("Error", "error" in res ? res.error : "Failed to save");
      }
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error("tx-detail", "update threw", { detail });
      Alert.alert("Error", "Cannot connect to server");
    } finally {
      setSaving(false);
    }
  };

  // Portfolio-op rows (buys/sells/transfers/swaps/income/etc.) carry a quantity
  // or a holding link. Editing them through the generic transactions PUT would
  // corrupt the leg pair — route them to the dedicated Portfolio OperationForm
  // instead (the load endpoint resolves the op kind + primary leg id).
  const isPortfolioRow =
    (transaction.quantity != null && transaction.quantity !== 0) ||
    transaction.portfolioHolding != null;

  const handleEditInPortfolio = async () => {
    try {
      const res = await endpoints.loadPortfolioOperation(transaction.id);
      if (res.success && res.data?.op) {
        // getParent() is the tab navigator; navigate into the Portfolio tab's
        // nested OperationForm. Cast to a permissive navigate (cross-navigator
        // params aren't expressible through the typed parent prop).
        const parent = navigation.getParent() as
          | { navigate: (name: string, params?: object) => void }
          | undefined;
        parent?.navigate("Portfolio", {
          screen: "OperationForm",
          params: { op: res.data.op, editId: res.data.primaryTxId },
        });
      } else {
        Alert.alert(
          "Edit on the web",
          "error" in res
            ? res.error
            : "This investment transaction can’t be edited on mobile yet."
        );
      }
    } catch (e) {
      logger.error("tx-detail", "portfolio-load threw", { detail: String(e) });
      Alert.alert("Error", "Cannot connect to server");
    }
  };

  const handleDelete = () => {
    Alert.alert("Delete Transaction", "Are you sure you want to delete this transaction?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            const res = await endpoints.deleteTransaction(transaction.id);
            if (res.success) {
              logger.info("tx-detail", "transaction deleted", { id: transaction.id });
              navigation.goBack();
            } else {
              logger.warn("tx-detail", "delete rejected", { id: transaction.id, error: res.error });
              Alert.alert("Error", "error" in res ? res.error : "Failed to delete");
            }
          } catch (e) {
            const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
            logger.error("tx-detail", "delete threw", { detail });
            Alert.alert("Error", "Cannot connect to server");
          }
        },
      },
    ]);
  };

  const renderField = (
    label: string,
    value: string,
    onChange?: (v: string) => void,
    options?: { multiline?: boolean; keyboardType?: "default" | "numeric" | "decimal-pad" }
  ) => (
    <View style={fieldStyles.container}>
      <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>{label}</Text>
      {editing && onChange ? (
        <TextInput
          style={[
            fieldStyles.input,
            {
              color: colors.foreground,
              backgroundColor: colors.secondary,
              borderColor: colors.border,
            },
            options?.multiline && { minHeight: 60, textAlignVertical: "top" },
          ]}
          value={value}
          onChangeText={onChange}
          multiline={options?.multiline}
          keyboardType={options?.keyboardType}
          placeholderTextColor={colors.mutedForeground}
        />
      ) : (
        <Text style={[fieldStyles.value, { color: colors.foreground }]}>{value || "—"}</Text>
      )}
    </View>
  );

  const renderPickerField = (
    label: string,
    displayValue: string,
    items: Array<{ id: number; name: string; group?: string }>,
    selectedId: number | null,
    onSelect: (id: number) => void
  ) => (
    <View style={fieldStyles.container}>
      <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>{label}</Text>
      {editing ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={fieldStyles.chipScroll}
        >
          {items.map((item) => (
            <TouchableOpacity
              key={item.id}
              onPress={() => onSelect(item.id)}
              style={[
                fieldStyles.chip,
                {
                  backgroundColor:
                    item.id === selectedId ? colors.primary : colors.secondary,
                  borderColor: colors.border,
                },
              ]}
            >
              <Text
                style={[
                  fieldStyles.chipText,
                  {
                    color:
                      item.id === selectedId
                        ? colors.primaryForeground
                        : colors.foreground,
                  },
                ]}
                numberOfLines={1}
              >
                {item.name}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      ) : (
        <Text style={[fieldStyles.value, { color: colors.foreground }]}>{displayValue}</Text>
      )}
    </View>
  );

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {/* Header */}
        <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => navigation.goBack()}>
            <Text style={[styles.backBtn, { color: colors.primary }]}>← Back</Text>
          </TouchableOpacity>
          <Text style={[styles.title, { color: colors.foreground }]}>Transaction</Text>
          <View style={styles.topActions}>
            {editing ? (
              <>
                <TouchableOpacity onPress={() => setEditing(false)}>
                  <Text style={[styles.actionBtn, { color: colors.mutedForeground }]}>
                    Cancel
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={handleSave} disabled={saving}>
                  {saving ? (
                    <ActivityIndicator size="small" color={colors.primary} />
                  ) : (
                    <Text style={[styles.actionBtn, { color: colors.primary }]}>Save</Text>
                  )}
                </TouchableOpacity>
              </>
            ) : (
              <>
                {isPortfolioRow ? (
                  <TouchableOpacity onPress={handleEditInPortfolio}>
                    <Text style={[styles.actionBtn, { color: colors.primary }]}>In Portfolio</Text>
                  </TouchableOpacity>
                ) : (
                  <>
                    <TouchableOpacity onPress={handleSplit}>
                      <Text style={[styles.actionBtn, { color: colors.primary }]}>Split</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => setEditing(true)}>
                      <Text style={[styles.actionBtn, { color: colors.primary }]}>Edit</Text>
                    </TouchableOpacity>
                  </>
                )}
                <TouchableOpacity onPress={handleDelete}>
                  <Text style={[styles.actionBtn, { color: colors.destructive }]}>Delete</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>

        <ScrollView contentContainerStyle={styles.scroll}>
          {/* Amount hero */}
          <View style={[styles.amountCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {editing ? (
              <TextInput
                style={[styles.amountInput, { color: colors.foreground }]}
                value={amount}
                onChangeText={setAmount}
                keyboardType="decimal-pad"
                textAlign="center"
              />
            ) : (
              <Text
                style={[
                  styles.amountText,
                  { color: transaction.amount >= 0 ? colors.pos : colors.foreground },
                ]}
              >
                {formatCurrency(transaction.amount, transaction.currency)}
              </Text>
            )}
            <Text style={[styles.currencyLabel, { color: colors.mutedForeground }]}>
              {transaction.currency}
            </Text>
          </View>

          {/* Split summary chip — tap to open the editor (non-portfolio rows). */}
          {splitCount > 0 && !isPortfolioRow && !editing && (
            <TouchableOpacity
              onPress={handleSplit}
              style={[styles.splitChip, { backgroundColor: colors.secondary, borderColor: colors.border }]}
            >
              <Icon name="split" size={14} color={colors.primary} />
              <Text style={[styles.splitChipText, { color: colors.foreground }]}>
                Split · {splitCount}
              </Text>
            </TouchableOpacity>
          )}

          {/* Fields */}
          <View
            style={[
              styles.card,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            {renderField("Date", date, setDate)}
            {renderField("Payee", payee, setPayee)}
            {renderPickerField("Account", accountName, accounts, selectedAccountId, setSelectedAccountId)}
            {renderPickerField(
              "Category",
              categoryName,
              categories,
              selectedCategoryId,
              setSelectedCategoryId
            )}
            {renderField("Note", note, setNote, { multiline: true })}
            {renderField("Tags", tags, setTags)}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: { fontSize: 15, fontWeight: "600" },
  title: { fontSize: 17, fontWeight: "700" },
  topActions: { flexDirection: "row", gap: 16 },
  actionBtn: { fontSize: 15, fontWeight: "600" },
  scroll: { padding: 16, paddingBottom: 32 },
  amountCard: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 24,
    marginBottom: 12,
    alignItems: "center",
  },
  amountText: { fontSize: 36, fontWeight: "800" },
  amountInput: { fontSize: 36, fontWeight: "800", textAlign: "center", minWidth: 200 },
  currencyLabel: { fontSize: 13, marginTop: 4 },
  splitChip: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginBottom: 12,
  },
  splitChipText: { fontSize: 13, fontWeight: "600" },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    marginBottom: 12,
  },
});

const fieldStyles = StyleSheet.create({
  container: { marginBottom: 16 },
  label: { fontSize: 12, fontWeight: "600", marginBottom: 4, textTransform: "uppercase" },
  value: { fontSize: 15 },
  input: {
    fontSize: 15,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  chipScroll: { flexDirection: "row", marginTop: 4 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    marginRight: 8,
  },
  chipText: { fontSize: 13, fontWeight: "500" },
});
