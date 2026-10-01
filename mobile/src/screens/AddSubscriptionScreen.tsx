// Add / edit a subscription. One screen + one payload builder for both modes
// (create drifting from edit is how loans broke on web). Edit mode also
// carries the status switch and Delete. Mirrors the web SubscriptionDialog.
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
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { safeAccountName, safeName } from "../lib/format";
import { COMMON_CURRENCIES } from "../lib/constants";
import { PickerSheet, type PickerOption } from "../components/picker-sheet";
import {
  FREQUENCY_LABELS,
  SUBSCRIPTION_FREQUENCIES,
  frequencyOrMonthly,
  isValidIsoDate,
} from "../lib/subscriptions";
import type {
  Account,
  Category,
  Subscription,
  SubscriptionFormData,
  SubscriptionFrequency,
} from "../../../shared/types";
import type { MoreStackParamList } from "../navigation/MoreStack";

const STATUSES: { value: Subscription["status"]; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "cancelled", label: "Cancelled" },
];

export interface SubscriptionFormState {
  name: string;
  amount: string;
  currency: string;
  frequency: SubscriptionFrequency;
  nextDate: string;
  categoryId: number | null;
  accountId: number | null;
  cancelReminderDate: string;
  notes: string;
  status: Subscription["status"];
}

/** Initial form state from an existing row (edit) or a detected prefill (review). */
export function subscriptionFormInit(
  sub: Subscription | null,
  prefill: Partial<SubscriptionFormData> | null,
): SubscriptionFormState {
  const src = sub ?? prefill ?? {};
  return {
    name: (sub ? sub.name : prefill?.name) ?? "",
    amount: src.amount != null ? String(src.amount) : "",
    currency: src.currency ?? "",
    frequency: frequencyOrMonthly(src.frequency ?? "monthly"),
    nextDate: src.nextDate ?? "",
    categoryId: src.categoryId ?? null,
    accountId: src.accountId ?? null,
    cancelReminderDate: src.cancelReminderDate ?? "",
    notes: src.notes ?? "",
    status: sub?.status ?? "active",
  };
}

/**
 * Validate + build the request body. Create OMITS empty optionals (a server
 * older than the 2026-10 merge rejects `null` there); edit sends `null` to
 * clear a field. Returns an error string instead when invalid.
 */
export function buildSubscriptionPayload(
  f: SubscriptionFormState,
  isEdit: boolean,
): { ok: true; body: SubscriptionFormData } | { ok: false; error: string } {
  const name = f.name.trim();
  if (!name) return { ok: false, error: "Please enter a name" };
  const amount = parseFloat(f.amount.replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Please enter an amount greater than 0" };
  const nextDate = f.nextDate.trim();
  if (nextDate && !isValidIsoDate(nextDate)) return { ok: false, error: "Next payment must be a date like 2026-10-15" };
  const reminder = f.cancelReminderDate.trim();
  if (reminder && !isValidIsoDate(reminder)) return { ok: false, error: "Cancel reminder must be a date like 2026-10-15" };

  const body: SubscriptionFormData = { name, amount, frequency: f.frequency };
  if (f.currency) body.currency = f.currency;
  const optional: [keyof SubscriptionFormData, string | number | null][] = [
    ["nextDate", nextDate || null],
    ["categoryId", f.categoryId],
    ["accountId", f.accountId],
    ["cancelReminderDate", reminder || null],
    ["notes", f.notes.trim() || null],
  ];
  for (const [k, v] of optional) {
    if (v !== null || isEdit) (body as unknown as Record<string, unknown>)[k] = v;
  }
  if (isEdit) body.status = f.status;
  return { ok: true, body };
}

export default function AddSubscriptionScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation<{ goBack: () => void }>();
  const route = useRoute<RouteProp<MoreStackParamList, "AddSubscription">>();
  const editSub = route.params?.subscription ?? null;
  const prefill = route.params?.prefill ?? null;
  const isEdit = !!editSub;
  const init = useMemo(() => subscriptionFormInit(editSub, prefill), [editSub, prefill]);

  const [form, setForm] = useState<SubscriptionFormState>(init);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [currencies, setCurrencies] = useState<string[]>([...COMMON_CURRENCIES]);
  const [openPicker, setOpenPicker] = useState<"account" | "category" | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const set = <K extends keyof SubscriptionFormState>(k: K, v: SubscriptionFormState[K]) =>
    setForm((prev) => ({ ...prev, [k]: v }));

  useEffect(() => {
    endpoints.getAccounts().then((r) => r.success && setAccounts(r.data ?? [])).catch(() => {});
    endpoints.getCategories().then((r) => r.success && setCategories(r.data ?? [])).catch(() => {});
    // The currency chips come from the user's own active set (never a fixed
    // list), always including the form's current value.
    endpoints
      .getActiveCurrencies()
      .then((r) => {
        if (r.success && Array.isArray(r.data?.active) && r.data.active.length > 0) setCurrencies(r.data.active);
      })
      .catch(() => {});
    // A new subscription defaults to the display currency.
    if (!init.currency) {
      endpoints
        .getDisplayCurrency()
        .then((r) => {
          if (r.success && r.data?.displayCurrency) {
            setForm((prev) => (prev.currency ? prev : { ...prev, currency: r.data.displayCurrency }));
          }
        })
        .catch(() => {});
    }
  }, [init.currency]);

  const currencyOptions = useMemo(
    () => (form.currency && !currencies.includes(form.currency) ? [form.currency, ...currencies] : currencies),
    [currencies, form.currency],
  );
  const accountOptions: PickerOption[] = useMemo(
    // /api/accounts already excludes archived accounts (the picker source).
    () => accounts.map((a) => ({ id: a.id, label: safeAccountName(a) })),
    [accounts],
  );
  const categoryOptions: PickerOption[] = useMemo(
    () => categories.map((c) => ({ id: c.id, label: safeName(c.name) })),
    [categories],
  );
  const accountLabel = form.accountId ? accounts.find((a) => a.id === form.accountId) : null;
  const categoryLabel = form.categoryId ? categories.find((c) => c.id === form.categoryId) : null;

  const handleSave = async () => {
    if (saving) return;
    const built = buildSubscriptionPayload(form, isEdit);
    if (!built.ok) {
      Alert.alert("Check the form", built.error);
      return;
    }
    setSaving(true);
    try {
      const res =
        isEdit && editSub
          ? await endpoints.updateSubscription({ id: editSub.id, ...built.body })
          : await endpoints.createSubscription(built.body);
      if (res.success) {
        logger.info("add-subscription", isEdit ? "updated" : "created", { frequency: form.frequency });
        navigation.goBack();
      } else {
        logger.warn("add-subscription", "save rejected", { error: res.error });
        Alert.alert("Couldn't save", res.error || "Please try again.");
      }
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error("add-subscription", "save threw", { detail });
      Alert.alert("Error", "Cannot connect to server");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = () => {
    if (!editSub) return;
    Alert.alert(
      "Delete subscription?",
      `Delete "${safeName(editSub.name, "this subscription")}"? Your transactions are not affected.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setDeleting(true);
            try {
              const res = await endpoints.deleteSubscription(editSub.id);
              if (res.success) navigation.goBack();
              else Alert.alert("Couldn't delete", res.error || "Please try again.");
            } catch (e) {
              const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
              logger.error("add-subscription", "delete threw", { detail });
              Alert.alert("Error", "Cannot connect to server");
            } finally {
              setDeleting(false);
            }
          },
        },
      ],
    );
  };

  const input = [fieldStyles.input, { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border }];

  const chips = <T extends string>(options: { value: T; label: string }[], selected: T, onSelect: (v: T) => void) => (
    <View style={fieldStyles.chipWrap}>
      {options.map((opt) => {
        const active = opt.value === selected;
        return (
          <TouchableOpacity
            key={opt.value}
            onPress={() => onSelect(opt.value)}
            style={[fieldStyles.chip, { backgroundColor: active ? colors.primary : colors.secondary, borderColor: colors.border }]}
            accessibilityState={{ selected: active }}
          >
            <Text style={[fieldStyles.chipText, { color: active ? colors.primaryForeground : colors.foreground }]}>{opt.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );

  const selectField = (label: string | null, placeholder: string, onPress: () => void, onClear?: () => void) => (
    <View style={fieldStyles.selectRow}>
      <TouchableOpacity style={[input, fieldStyles.selectBox]} onPress={onPress}>
        <Text style={{ color: label ? colors.foreground : colors.mutedForeground, fontSize: 15 }} numberOfLines={1}>
          {label ?? placeholder}
        </Text>
      </TouchableOpacity>
      {label && onClear ? (
        <TouchableOpacity onPress={onClear} style={fieldStyles.clearBtn} hitSlop={8}>
          <Text style={{ color: colors.mutedForeground, fontWeight: "600" }}>Clear</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => navigation.goBack()}>
            <Text style={[styles.backBtn, { color: colors.primary }]}>Cancel</Text>
          </TouchableOpacity>
          <Text style={[styles.title, { color: colors.foreground }]}>{isEdit ? "Edit subscription" : "New subscription"}</Text>
          <TouchableOpacity onPress={handleSave} disabled={saving}>
            {saving ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Text style={[styles.saveBtn, { color: colors.primary }]}>Save</Text>
            )}
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>NAME</Text>
              <TextInput
                style={input}
                value={form.name}
                onChangeText={(v) => set("name", v)}
                placeholder="e.g. Netflix, car insurance"
                placeholderTextColor={colors.mutedForeground}
                autoFocus={!isEdit && !prefill}
              />
            </View>

            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>AMOUNT PER PAYMENT</Text>
              <TextInput
                style={input}
                value={form.amount}
                onChangeText={(v) => set("amount", v)}
                keyboardType="decimal-pad"
                placeholder="0.00"
                placeholderTextColor={colors.mutedForeground}
              />
            </View>

            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>HOW OFTEN</Text>
              {chips(
                SUBSCRIPTION_FREQUENCIES.map((f) => ({ value: f, label: FREQUENCY_LABELS[f] })),
                form.frequency,
                (v) => set("frequency", v),
              )}
            </View>

            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>CURRENCY</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {chips(currencyOptions.map((c) => ({ value: c, label: c })), form.currency, (v) => set("currency", v))}
              </ScrollView>
            </View>

            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>NEXT PAYMENT (YYYY-MM-DD)</Text>
              <TextInput
                style={input}
                value={form.nextDate}
                onChangeText={(v) => set("nextDate", v)}
                placeholder="2026-10-15"
                placeholderTextColor={colors.mutedForeground}
                autoCapitalize="none"
              />
            </View>

            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>CATEGORY (OPTIONAL)</Text>
              {selectField(categoryLabel ? safeName(categoryLabel.name) : null, "None", () => setOpenPicker("category"), () => set("categoryId", null))}
            </View>

            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>PAID FROM (OPTIONAL)</Text>
              {selectField(accountLabel ? safeAccountName(accountLabel) : null, "None", () => setOpenPicker("account"), () => set("accountId", null))}
            </View>

            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>REMIND ME TO CANCEL ON (OPTIONAL)</Text>
              <TextInput
                style={input}
                value={form.cancelReminderDate}
                onChangeText={(v) => set("cancelReminderDate", v)}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={colors.mutedForeground}
                autoCapitalize="none"
              />
            </View>

            <View style={[fieldStyles.container, { marginBottom: isEdit ? 16 : 0 }]}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>NOTES (OPTIONAL)</Text>
              <TextInput
                style={[input, { minHeight: 56, textAlignVertical: "top" }]}
                value={form.notes}
                onChangeText={(v) => set("notes", v)}
                placeholder="Optional note"
                placeholderTextColor={colors.mutedForeground}
                multiline
              />
            </View>

            {isEdit && (
              <View style={[fieldStyles.container, { marginBottom: 0 }]}>
                <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>STATUS</Text>
                {chips(STATUSES, form.status, (v) => set("status", v))}
              </View>
            )}
          </View>

          {isEdit && (
            <TouchableOpacity
              style={[styles.deleteBtn, { borderColor: colors.destructive }]}
              onPress={handleDelete}
              disabled={deleting}
            >
              {deleting ? (
                <ActivityIndicator size="small" color={colors.destructive} />
              ) : (
                <Text style={[styles.deleteText, { color: colors.destructive }]}>Delete subscription</Text>
              )}
            </TouchableOpacity>
          )}
        </ScrollView>

        <PickerSheet
          visible={openPicker === "category"}
          title="Select category"
          options={categoryOptions}
          selectedId={form.categoryId}
          onSelect={(id) => set("categoryId", id)}
          onClose={() => setOpenPicker(null)}
        />
        <PickerSheet
          visible={openPicker === "account"}
          title="Paid from"
          options={accountOptions}
          selectedId={form.accountId}
          onSelect={(id) => set("accountId", id)}
          onClose={() => setOpenPicker(null)}
        />
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
  saveBtn: { fontSize: 15, fontWeight: "700" },
  scroll: { padding: 16, paddingBottom: 32 },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 16, marginBottom: 12 },
  deleteBtn: { height: 46, borderRadius: 10, borderWidth: 1, alignItems: "center", justifyContent: "center", marginBottom: 12 },
  deleteText: { fontSize: 15, fontWeight: "700" },
});

const fieldStyles = StyleSheet.create({
  container: { marginBottom: 16 },
  label: { fontSize: 12, fontWeight: "600", marginBottom: 6 },
  input: { fontSize: 15, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  chipWrap: { flexDirection: "row", flexWrap: "wrap" },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, marginRight: 8, marginBottom: 8 },
  chipText: { fontSize: 13, fontWeight: "600" },
  selectRow: { flexDirection: "row", alignItems: "center" },
  selectBox: { flex: 1, justifyContent: "center", minHeight: 42 },
  clearBtn: { paddingHorizontal: 10, paddingVertical: 8 },
});
