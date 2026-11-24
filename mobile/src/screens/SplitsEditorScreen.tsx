import React, { useEffect, useMemo, useState } from "react";
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
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { formatCurrency, safeName } from "../lib/format";
import { Icon } from "../components/icon";
import { TagInput } from "../components/TagInput";
import { PickerSheet, type PickerOption } from "../components/picker-sheet";
import {
  emptySplitDraft,
  splitAllocated,
  splitRemaining,
  splitsBalanced,
  canSaveSplits,
  buildSplitInputs,
  draftsFromSplits,
  type SplitDraft,
} from "../lib/splits";
import type { Account, Category } from "../../../shared/types";
import type { TransactionsStackParamList } from "../navigation/TransactionsStack";

type Props = NativeStackScreenProps<TransactionsStackParamList, "SplitsEditor">;

// Sentinel id for the "None" picker option so category/account can be cleared
// back to null (both columns are nullable server-side). Real ids are positive
// serials, so a negative sentinel never collides.
const NONE_ID = -1;

export default function SplitsEditorScreen({ route, navigation }: Props) {
  const { colors } = useTheme();
  const { transactionId, totalAmount, currency } = route.params;

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [rows, setRows] = useState<SplitDraft[]>([emptySplitDraft(), emptySplitDraft()]);
  const [hadExisting, setHadExisting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Which row's picker is open, if any.
  const [openPicker, setOpenPicker] = useState<{ index: number; kind: "category" | "account" } | null>(
    null
  );

  useEffect(() => {
    Promise.all([
      endpoints.getAccounts(),
      endpoints.getCategories(),
      endpoints.getSplits(transactionId),
    ])
      .then(([accRes, catRes, splitRes]) => {
        if (accRes.success) setAccounts(accRes.data);
        else logger.warn("splits", "accounts fetch failed", { error: accRes.error });
        if (catRes.success) setCategories(catRes.data);
        else logger.warn("splits", "categories fetch failed", { error: catRes.error });
        if (splitRes.success && Array.isArray(splitRes.data) && splitRes.data.length > 0) {
          setRows(draftsFromSplits(splitRes.data));
          setHadExisting(true);
          logger.info("splits", "loaded existing", { count: splitRes.data.length });
        }
        setLoading(false);
      })
      .catch((e) => {
        const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        logger.error("splits", "load threw", { detail });
        setLoading(false);
      });
  }, [transactionId]);

  // Derived balance state (pure helpers, unit-tested in splits.test.ts).
  const allocated = splitAllocated(rows);
  const remaining = splitRemaining(totalAmount, rows);
  const balanced = splitsBalanced(totalAmount, rows);
  const canSave = canSaveSplits(totalAmount, rows);

  const categoryOptions: PickerOption[] = useMemo(
    () => [
      { id: NONE_ID, label: "None" },
      ...categories.map((c) => ({ id: c.id, label: safeName(c.name), sublabel: c.group || undefined })),
    ],
    [categories]
  );
  const accountOptions: PickerOption[] = useMemo(
    () => [
      { id: NONE_ID, label: "None" },
      ...accounts.map((a) => ({ id: a.id, label: safeName(a.name), sublabel: a.currency })),
    ],
    [accounts]
  );

  const categoryLabel = (id: number | null) => {
    if (id == null) return null;
    const c = categories.find((x) => x.id === id);
    return c ? safeName(c.name) : `Category #${id}`;
  };
  const accountLabel = (id: number | null) => {
    if (id == null) return null;
    const a = accounts.find((x) => x.id === id);
    return a ? safeName(a.name) : `Account #${id}`;
  };

  const setRow = (index: number, patch: Partial<SplitDraft>) =>
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const addRow = () => setRows((prev) => [...prev, emptySplitDraft()]);
  const removeRow = (index: number) => setRows((prev) => prev.filter((_, i) => i !== index));

  const handleSave = async () => {
    if (!canSave) {
      Alert.alert("Not balanced", "Add at least two rows that sum to the transaction total.");
      return;
    }
    setSaving(true);
    try {
      const res = await endpoints.saveSplits(transactionId, buildSplitInputs(totalAmount, rows));
      if (res.success) {
        logger.info("splits", "saved", { transactionId });
        navigation.goBack();
      } else {
        logger.warn("splits", "save rejected", { transactionId, error: res.error });
        Alert.alert("Error", "error" in res ? res.error : "Failed to save splits");
      }
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error("splits", "save threw", { detail });
      Alert.alert("Error", "Cannot connect to server");
    } finally {
      setSaving(false);
    }
  };

  const handleClear = () => {
    Alert.alert("Clear splits", "Remove all split rows from this transaction?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear",
        style: "destructive",
        onPress: async () => {
          setSaving(true);
          try {
            const res = await endpoints.deleteSplits(transactionId);
            if (res.success) {
              logger.info("splits", "cleared", { transactionId });
              navigation.goBack();
            } else {
              logger.warn("splits", "clear rejected", { transactionId, error: res.error });
              Alert.alert("Error", "error" in res ? res.error : "Failed to clear splits");
            }
          } catch (e) {
            const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
            logger.error("splits", "clear threw", { detail });
            Alert.alert("Error", "Cannot connect to server");
          } finally {
            setSaving(false);
          }
        },
      },
    ]);
  };

  // Balance badge — emerald balanced / amber under / coral over.
  const badge = balanced
    ? { color: colors.pos, text: "Balanced" }
    : remaining > 0
      ? { color: colors.primary, text: `${formatCurrency(remaining, currency)} left` }
      : { color: colors.neg, text: `${formatCurrency(Math.abs(remaining), currency)} over` };

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  // Tappable summary field that opens the searchable picker sheet.
  const renderSelectField = (valueText: string | null, placeholder: string, onPress: () => void) => (
    <TouchableOpacity
      onPress={onPress}
      style={[fieldStyles.selectField, { backgroundColor: colors.secondary, borderColor: colors.border }]}
    >
      <Text
        style={[fieldStyles.selectText, { color: valueText ? colors.foreground : colors.mutedForeground }]}
        numberOfLines={1}
      >
        {valueText ?? placeholder}
      </Text>
      <Icon name="chevronDown" size={16} color={colors.mutedForeground} />
    </TouchableOpacity>
  );

  const pickerRow = openPicker ? rows[openPicker.index] : undefined;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {/* Header */}
        <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => navigation.goBack()}>
            <Text style={[styles.backBtn, { color: colors.primary }]}>Cancel</Text>
          </TouchableOpacity>
          <Text style={[styles.title, { color: colors.foreground }]}>Split transaction</Text>
          <TouchableOpacity onPress={handleSave} disabled={saving || !canSave}>
            {saving ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Text
                style={[styles.saveBtn, { color: canSave ? colors.primary : colors.mutedForeground }]}
              >
                Save
              </Text>
            )}
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          {/* Total + balance badge */}
          <View style={[styles.summaryCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View>
              <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>TRANSACTION TOTAL</Text>
              <Text style={[styles.summaryTotal, { color: colors.foreground }]}>
                {formatCurrency(totalAmount, currency)}
              </Text>
              <Text style={[styles.summarySub, { color: colors.mutedForeground }]}>
                Allocated {formatCurrency(totalAmount < 0 ? -allocated : allocated, currency)}
              </Text>
            </View>
            <View style={[styles.badge, { backgroundColor: badge.color }]}>
              <Text style={styles.badgeText}>{badge.text}</Text>
            </View>
          </View>

          {/* Split rows */}
          {rows.map((row, i) => (
            <View
              key={i}
              style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <View style={styles.rowHeader}>
                <Text style={[styles.rowTitle, { color: colors.foreground }]}>Split {i + 1}</Text>
                <TouchableOpacity
                  onPress={() => removeRow(i)}
                  disabled={rows.length <= 2}
                  hitSlop={8}
                >
                  <Icon
                    name="trash"
                    size={18}
                    color={rows.length <= 2 ? colors.border : colors.destructive}
                  />
                </TouchableOpacity>
              </View>

              <View style={fieldStyles.container}>
                <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>CATEGORY</Text>
                {renderSelectField(categoryLabel(row.categoryId), "None", () =>
                  setOpenPicker({ index: i, kind: "category" })
                )}
              </View>

              <View style={fieldStyles.container}>
                <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>ACCOUNT</Text>
                {renderSelectField(accountLabel(row.accountId), "None", () =>
                  setOpenPicker({ index: i, kind: "account" })
                )}
              </View>

              <View style={fieldStyles.container}>
                <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>AMOUNT</Text>
                <TextInput
                  style={[
                    fieldStyles.input,
                    { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border },
                  ]}
                  value={row.amount}
                  onChangeText={(v) => setRow(i, { amount: v })}
                  keyboardType="decimal-pad"
                  placeholder="0.00"
                  placeholderTextColor={colors.mutedForeground}
                />
              </View>

              <View style={fieldStyles.container}>
                <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>NOTE</Text>
                <TextInput
                  style={[
                    fieldStyles.input,
                    { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border },
                  ]}
                  value={row.note}
                  onChangeText={(v) => setRow(i, { note: v })}
                  placeholder="Optional note"
                  placeholderTextColor={colors.mutedForeground}
                />
              </View>

              <View style={[fieldStyles.container, { marginBottom: 0 }]}>
                <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>TAGS</Text>
                <TagInput
                  value={row.tags}
                  onValueChange={(v) => setRow(i, { tags: v })}
                  accessibilityLabel={`Tags for split ${i + 1}`}
                />
              </View>
            </View>
          ))}

          {/* Add row */}
          <TouchableOpacity
            style={[styles.addRowBtn, { borderColor: colors.border }]}
            onPress={addRow}
          >
            <Icon name="add" size={16} color={colors.primary} />
            <Text style={[styles.addRowText, { color: colors.primary }]}>Add row</Text>
          </TouchableOpacity>

          {/* Clear splits — only when the transaction already has saved splits */}
          {hadExisting && (
            <TouchableOpacity
              style={[styles.clearBtn, { borderColor: colors.destructive }]}
              onPress={handleClear}
              disabled={saving}
            >
              <Text style={[styles.clearText, { color: colors.destructive }]}>Clear splits</Text>
            </TouchableOpacity>
          )}

          <Text style={[styles.hint, { color: colors.mutedForeground }]}>
            Splits divide this transaction for reporting. They don’t change the parent’s amount,
            account, or category.
          </Text>
        </ScrollView>

        {/* Single shared picker sheet (category OR account for the open row). */}
        <PickerSheet
          visible={openPicker !== null}
          title={openPicker?.kind === "account" ? "Select account" : "Select category"}
          options={openPicker?.kind === "account" ? accountOptions : categoryOptions}
          selectedId={
            pickerRow
              ? openPicker?.kind === "account"
                ? pickerRow.accountId
                : pickerRow.categoryId
              : null
          }
          onSelect={(id) => {
            if (!openPicker) return;
            const value = id === NONE_ID ? null : id;
            setRow(openPicker.index, openPicker.kind === "account" ? { accountId: value } : { categoryId: value });
          }}
          onClose={() => setOpenPicker(null)}
        />
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
  scroll: { padding: 16, paddingBottom: 48 },
  summaryCard: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    marginBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  summaryLabel: { fontSize: 11, fontWeight: "600", textTransform: "uppercase", marginBottom: 4 },
  summaryTotal: { fontSize: 24, fontWeight: "800" },
  summarySub: { fontSize: 12, marginTop: 2 },
  badge: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999 },
  badgeText: { fontSize: 13, fontWeight: "700", color: "#ffffff" },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    marginBottom: 12,
  },
  rowHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  rowTitle: { fontSize: 15, fontWeight: "700" },
  addRowBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: "dashed",
    borderRadius: 10,
    paddingVertical: 12,
    marginBottom: 12,
  },
  addRowText: { fontSize: 15, fontWeight: "600" },
  clearBtn: {
    alignItems: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingVertical: 12,
    marginBottom: 16,
  },
  clearText: { fontSize: 15, fontWeight: "600" },
  hint: { fontSize: 12, lineHeight: 17, textAlign: "center" },
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
  selectField: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  selectText: { fontSize: 15, flex: 1, marginRight: 8 },
});
