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
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import type { Account, Category } from "../../../shared/types";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { TransactionsStackParamList } from "../navigation/TransactionsStack";

type Props = NativeStackScreenProps<TransactionsStackParamList, "AddTransaction">;

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function AddTransactionScreen({ navigation }: Props) {
  const theme = useTheme();
  const colors = theme.colors;

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Form state
  const [date, setDate] = useState(todayStr());
  const [amount, setAmount] = useState("");
  const [payee, setPayee] = useState("");
  const [note, setNote] = useState("");
  const [tags, setTags] = useState("");
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(null);
  const [isExpense, setIsExpense] = useState(true);

  useEffect(() => {
    Promise.all([endpoints.getAccounts(), endpoints.getCategories()]).then(([accRes, catRes]) => {
      if (accRes.success) {
        setAccounts(accRes.data);
        if (accRes.data.length > 0) setSelectedAccountId(accRes.data[0].id);
      }
      if (catRes.success) setCategories(catRes.data);
      setLoading(false);
    });
  }, []);

  const filteredCategories = categories.filter((c) =>
    isExpense ? c.type === "E" : c.type === "I"
  );

  const handleSave = async () => {
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
        navigation.goBack();
      } else {
        Alert.alert("Error", "error" in res ? res.error : "Failed to create transaction");
      }
    } catch {
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

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {/* Header */}
        <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => navigation.goBack()}>
            <Text style={[styles.backBtn, { color: colors.primary }]}>← Cancel</Text>
          </TouchableOpacity>
          <Text style={[styles.title, { color: colors.foreground }]}>Add Transaction</Text>
          <TouchableOpacity onPress={handleSave} disabled={saving}>
            {saving ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Text style={[styles.saveBtn, { color: colors.primary }]}>Save</Text>
            )}
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.scroll}>
          {/* Type Toggle */}
          <View style={[styles.toggleRow, { backgroundColor: colors.secondary, borderRadius: 10 }]}>
            <TouchableOpacity
              style={[
                styles.toggleBtn,
                isExpense && { backgroundColor: colors.destructive },
              ]}
              onPress={() => setIsExpense(true)}
            >
              <Text
                style={[
                  styles.toggleText,
                  { color: isExpense ? colors.destructiveForeground : colors.mutedForeground },
                ]}
              >
                Expense
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.toggleBtn,
                !isExpense && { backgroundColor: colors.chart3 },
              ]}
              onPress={() => setIsExpense(false)}
            >
              <Text
                style={[
                  styles.toggleText,
                  { color: !isExpense ? "#fff" : colors.mutedForeground },
                ]}
              >
                Income
              </Text>
            </TouchableOpacity>
          </View>

          {/* Amount Input */}
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

          {/* Form Fields */}
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {/* Date */}
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

            {/* Account Picker */}
            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>ACCOUNT</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {accounts.map((acc) => (
                  <TouchableOpacity
                    key={acc.id}
                    onPress={() => setSelectedAccountId(acc.id)}
                    style={[
                      fieldStyles.chip,
                      {
                        backgroundColor: acc.id === selectedAccountId ? colors.primary : colors.secondary,
                        borderColor: colors.border,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        fieldStyles.chipText,
                        { color: acc.id === selectedAccountId ? colors.primaryForeground : colors.foreground },
                      ]}
                      numberOfLines={1}
                    >
                      {acc.name}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>

            {/* Category Picker */}
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
                      {cat.name}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>

            {/* Note */}
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
  },
  toggleBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: "center",
  },
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
  amountInput: { fontSize: 36, fontWeight: "800", minWidth: 150, textAlign: "center" },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    marginBottom: 12,
  },
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
