import React, { useEffect, useState } from "react";
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
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { safeName } from "../lib/format";
import type { Account, Category } from "../../../shared/types";

type Mode = "expense" | "income" | "transfer";

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Read-only nav surface this screen needs — keeps it usable from any stack
// (Transactions and More both register it).
type AddRoute = RouteProp<{ AddTransaction?: { mode?: Mode } }, "AddTransaction">;

export default function AddTransactionScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation<{ goBack: () => void }>();
  const route = useRoute<AddRoute>();

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [mode, setMode] = useState<Mode>(route.params?.mode ?? "expense");

  // Shared form state
  const [date, setDate] = useState(todayStr());
  const [amount, setAmount] = useState("");
  const [payee, setPayee] = useState("");
  const [note, setNote] = useState("");
  const [tags, setTags] = useState("");
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(null);

  // Transfer-only state
  const [fromAccountId, setFromAccountId] = useState<number | null>(null);
  const [toAccountId, setToAccountId] = useState<number | null>(null);

  useEffect(() => {
    Promise.all([endpoints.getAccounts(), endpoints.getCategories()])
      .then(([accRes, catRes]) => {
        if (accRes.success) {
          setAccounts(accRes.data);
          if (accRes.data.length > 0) {
            setSelectedAccountId(accRes.data[0].id);
            setFromAccountId(accRes.data[0].id);
            if (accRes.data.length > 1) setToAccountId(accRes.data[1].id);
          }
        } else {
          logger.warn("add-tx", "accounts fetch failed", { error: accRes.error });
        }
        if (catRes.success) setCategories(catRes.data);
        else logger.warn("add-tx", "categories fetch failed", { error: catRes.error });
        setLoading(false);
      })
      .catch((e) => {
        const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        logger.error("add-tx", "load threw", { detail });
        setLoading(false);
      });
  }, []);

  const isExpense = mode === "expense";
  const isTransfer = mode === "transfer";
  const filteredCategories = categories.filter((c) =>
    isExpense ? c.type === "E" : c.type === "I"
  );
  const fromAccount = accounts.find((a) => a.id === fromAccountId);
  const toAccount = accounts.find((a) => a.id === toAccountId);
  const currencyMismatch =
    isTransfer && !!fromAccount && !!toAccount && fromAccount.currency !== toAccount.currency;

  const handleSaveEntry = async () => {
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount === 0) {
      Alert.alert("Error", "Please enter a valid amount");
      return;
    }
    if (!selectedAccountId) {
      Alert.alert("Error", "Please select an account");
      return;
    }
    if (!selectedCategoryId) {
      Alert.alert("Error", "Please select a category");
      return;
    }
    const finalAmount = isExpense ? -Math.abs(parsedAmount) : Math.abs(parsedAmount);
    const currency = accounts.find((a) => a.id === selectedAccountId)?.currency ?? "CAD";

    setSaving(true);
    try {
      const res = await endpoints.createTransaction({
        date,
        amount: finalAmount,
        accountId: selectedAccountId,
        categoryId: selectedCategoryId,
        currency,
        payee: payee || undefined,
        note: note || undefined,
        tags: tags || undefined,
      });
      if (res.success) {
        logger.info("add-tx", "transaction created", { mode });
        navigation.goBack();
      } else {
        logger.warn("add-tx", "create rejected", { error: res.error });
        Alert.alert("Error", "error" in res ? res.error : "Failed to create transaction");
      }
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error("add-tx", "create threw", { detail });
      Alert.alert("Error", "Cannot connect to server");
    } finally {
      setSaving(false);
    }
  };

  const handleSaveTransfer = async () => {
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      Alert.alert("Error", "Please enter a valid amount");
      return;
    }
    if (!fromAccountId || !toAccountId) {
      Alert.alert("Error", "Pick both a From and a To account");
      return;
    }
    if (fromAccountId === toAccountId) {
      Alert.alert("Error", "From and To must be different accounts");
      return;
    }
    if (currencyMismatch) {
      Alert.alert(
        "Use the web app",
        "Cross-currency (FX) transfers must be done on the web app where you can lock the exchange rate."
      );
      return;
    }

    setSaving(true);
    try {
      const res = await endpoints.recordTransfer({
        fromAccountId,
        toAccountId,
        enteredAmount: Math.abs(parsedAmount),
        date,
        note: note || undefined,
      });
      if (res.success) {
        logger.info("add-tx", "transfer created");
        navigation.goBack();
      } else {
        logger.warn("add-tx", "transfer rejected", { error: res.error });
        Alert.alert("Error", "error" in res ? res.error : "Failed to create transfer");
      }
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error("add-tx", "transfer threw", { detail });
      Alert.alert("Error", "Cannot connect to server");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  // A brand-new user has no accounts/categories yet, so there's nothing to pick.
  // Don't strand them on an unusable form — point at the create flows + the
  // one-tap sample-data shortcut. The list screens (Accounts → + Add, More →
  // Categories → + Add) are the primary path.
  if (accounts.length === 0 || categories.length === 0) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
        <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => navigation.goBack()}>
            <Text style={[styles.backBtn, { color: colors.primary }]}>Cancel</Text>
          </TouchableOpacity>
          <Text style={[styles.title, { color: colors.foreground }]}>Add Transaction</Text>
          <View style={{ width: 48 }} />
        </View>
        <View style={styles.emptyState}>
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Set up first</Text>
          {accounts.length === 0 && (
            <Text style={[styles.emptyLine, { color: colors.mutedForeground }]}>
              • Add an account: Accounts tab → + Add
            </Text>
          )}
          {categories.length === 0 && (
            <Text style={[styles.emptyLine, { color: colors.mutedForeground }]}>
              • Add a category: More → Categories → + Add
            </Text>
          )}
          <Text style={[styles.emptyLine, { color: colors.mutedForeground, marginTop: 8 }]}>
            Or tap “Load sample data” on the More tab to get started instantly.
          </Text>
          <TouchableOpacity
            style={[styles.goBackBtn, { backgroundColor: colors.primary }]}
            onPress={() => navigation.goBack()}
          >
            <Text style={[styles.goBackBtnText, { color: colors.primaryForeground }]}>Go back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const segments: { key: Mode; label: string; activeBg: string; activeFg: string }[] = [
    { key: "expense", label: "Expense", activeBg: colors.neg, activeFg: "#ffffff" },
    { key: "income", label: "Income", activeBg: colors.pos, activeFg: "#ffffff" },
    { key: "transfer", label: "Transfer", activeBg: colors.primary, activeFg: colors.primaryForeground },
  ];

  const renderAccountChips = (
    selectedId: number | null,
    onSelect: (id: number) => void
  ) => (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      {accounts.map((acc) => (
        <TouchableOpacity
          key={acc.id}
          onPress={() => onSelect(acc.id)}
          style={[
            fieldStyles.chip,
            {
              backgroundColor: acc.id === selectedId ? colors.primary : colors.secondary,
              borderColor: colors.border,
            },
          ]}
        >
          <Text
            style={[
              fieldStyles.chipText,
              { color: acc.id === selectedId ? colors.primaryForeground : colors.foreground },
            ]}
            numberOfLines={1}
          >
            {safeName(acc.name)}
          </Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => navigation.goBack()}>
            <Text style={[styles.backBtn, { color: colors.primary }]}>Cancel</Text>
          </TouchableOpacity>
          <Text style={[styles.title, { color: colors.foreground }]}>
            {isTransfer ? "Transfer" : "Add Transaction"}
          </Text>
          <TouchableOpacity
            onPress={isTransfer ? handleSaveTransfer : handleSaveEntry}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Text style={[styles.saveBtn, { color: colors.primary }]}>Save</Text>
            )}
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.scroll}>
          {/* Segmented control: Expense / Income / Transfer */}
          <View style={[styles.toggleRow, { backgroundColor: colors.secondary }]}>
            {segments.map((seg) => {
              const active = mode === seg.key;
              return (
                <TouchableOpacity
                  key={seg.key}
                  style={[styles.toggleBtn, active && { backgroundColor: seg.activeBg }]}
                  onPress={() => setMode(seg.key)}
                >
                  <Text
                    style={[
                      styles.toggleText,
                      { color: active ? seg.activeFg : colors.mutedForeground },
                    ]}
                  >
                    {seg.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Amount */}
          <View style={[styles.amountCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.amountPrefix, { color: colors.mutedForeground }]}>$</Text>
            <TextInput
              style={[styles.amountInput, { color: colors.foreground }]}
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              placeholder="0.00"
              placeholderTextColor={colors.mutedForeground}
              autoFocus
            />
          </View>

          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {/* Date — shared */}
            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>DATE</Text>
              <TextInput
                style={[fieldStyles.input, { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border }]}
                value={date}
                onChangeText={setDate}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={colors.mutedForeground}
              />
            </View>

            {isTransfer ? (
              <>
                {/* From account */}
                <View style={fieldStyles.container}>
                  <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>FROM</Text>
                  {renderAccountChips(fromAccountId, setFromAccountId)}
                </View>
                {/* To account */}
                <View style={fieldStyles.container}>
                  <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>TO</Text>
                  {renderAccountChips(toAccountId, setToAccountId)}
                </View>
                {currencyMismatch && (
                  <Text style={[styles.warning, { color: colors.neg }]}>
                    Cross-currency transfer — do this on the web app to lock the FX rate.
                  </Text>
                )}
              </>
            ) : (
              <>
                {/* Payee */}
                <View style={fieldStyles.container}>
                  <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>PAYEE</Text>
                  <TextInput
                    style={[fieldStyles.input, { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border }]}
                    value={payee}
                    onChangeText={setPayee}
                    placeholder="Merchant or payee name"
                    placeholderTextColor={colors.mutedForeground}
                  />
                </View>

                {/* Account */}
                <View style={fieldStyles.container}>
                  <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>ACCOUNT</Text>
                  {renderAccountChips(selectedAccountId, setSelectedAccountId)}
                </View>

                {/* Category */}
                <View style={fieldStyles.container}>
                  <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>CATEGORY</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    {filteredCategories.map((cat) => (
                      <TouchableOpacity
                        key={cat.id}
                        onPress={() => setSelectedCategoryId(cat.id)}
                        style={[
                          fieldStyles.chip,
                          {
                            backgroundColor: cat.id === selectedCategoryId ? colors.primary : colors.secondary,
                            borderColor: colors.border,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            fieldStyles.chipText,
                            { color: cat.id === selectedCategoryId ? colors.primaryForeground : colors.foreground },
                          ]}
                          numberOfLines={1}
                        >
                          {safeName(cat.name)}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </View>

                {/* Tags */}
                <View style={fieldStyles.container}>
                  <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>TAGS</Text>
                  <TextInput
                    style={[fieldStyles.input, { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border }]}
                    value={tags}
                    onChangeText={setTags}
                    placeholder="Comma-separated tags"
                    placeholderTextColor={colors.mutedForeground}
                  />
                </View>
              </>
            )}

            {/* Note — shared */}
            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>NOTE</Text>
              <TextInput
                style={[
                  fieldStyles.input,
                  { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border, minHeight: 60, textAlignVertical: "top" },
                ]}
                value={note}
                onChangeText={setNote}
                placeholder="Optional note"
                placeholderTextColor={colors.mutedForeground}
                multiline
              />
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
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
  saveBtn: { fontSize: 15, fontWeight: "700" },
  scroll: { padding: 16, paddingBottom: 32 },
  toggleRow: {
    flexDirection: "row",
    marginBottom: 16,
    padding: 3,
    borderRadius: 10,
  },
  toggleBtn: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: "center" },
  toggleText: { fontSize: 14, fontWeight: "600" },
  amountCard: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 20,
    marginBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  amountPrefix: { fontSize: 32, fontWeight: "700", marginRight: 4 },
  amountInput: {
    fontSize: 36,
    fontWeight: "800",
    minWidth: 150,
    textAlign: "center",
    fontVariant: ["tabular-nums"],
  },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    marginBottom: 12,
  },
  warning: { fontSize: 13, marginTop: 4, marginBottom: 8 },
  emptyState: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  emptyTitle: { fontSize: 18, fontWeight: "700", marginBottom: 16 },
  emptyLine: { fontSize: 14, textAlign: "center", lineHeight: 20, marginBottom: 4 },
  goBackBtn: { marginTop: 24, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10 },
  goBackBtnText: { fontSize: 15, fontWeight: "700" },
});

const fieldStyles = StyleSheet.create({
  container: { marginBottom: 16 },
  label: { fontSize: 12, fontWeight: "600", marginBottom: 6 },
  input: {
    fontSize: 15,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    marginRight: 8,
  },
  chipText: { fontSize: 13, fontWeight: "500" },
});
