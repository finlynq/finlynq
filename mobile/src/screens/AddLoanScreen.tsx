// Add / edit a loan. One screen and one payload builder for both modes, the
// same fields as the web's Loans dialog: how the interest is worked out (a
// yearly rate, a fixed amount in every payment, or a total for the whole loan),
// a term or a payment, and the account the loan is tracked on.
//
// The server has the last word: it refuses a loan whose payment never pays it
// off, and its message is shown as is.
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
import { localDateISO } from "../lib/subscriptions";
import { PickerSheet, type PickerOption } from "../components/picker-sheet";
import {
  LOAN_FREQUENCY_OPTIONS,
  LOAN_INTEREST_OPTIONS,
  LOAN_TYPE_OPTIONS,
  buildLoanPayload,
  loanFormInit,
  type LoanFormState,
} from "../lib/loans";
import type { Account } from "../../../shared/types";
import type { MoreStackParamList } from "../navigation/MoreStack";

export default function AddLoanScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation<{ goBack: () => void; navigate: (screen: "Loans") => void }>();
  const route = useRoute<RouteProp<MoreStackParamList, "AddLoan">>();
  const editLoan = route.params?.loan ?? null;
  const isEdit = !!editLoan;
  const init = useMemo(() => loanFormInit(editLoan, localDateISO()), [editLoan]);

  const [form, setForm] = useState<LoanFormState>(init);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [currencies, setCurrencies] = useState<string[]>([...COMMON_CURRENCIES]);
  const [accountPickerOpen, setAccountPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const set = <K extends keyof LoanFormState>(k: K, v: LoanFormState[K]) =>
    setForm((prev) => ({ ...prev, [k]: v }));

  useEffect(() => {
    endpoints.getAccounts().then((r) => r.success && setAccounts(r.data ?? [])).catch(() => {});
    // Currency chips come from the user's own active set, never a fixed list.
    endpoints
      .getActiveCurrencies()
      .then((r) => {
        if (r.success && Array.isArray(r.data?.active) && r.data.active.length > 0) setCurrencies(r.data.active);
      })
      .catch(() => {});
    // A new loan starts in the display currency until an account says otherwise.
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
  // Interest is booked on the linked account, which cannot be an investment
  // account. The one already linked stays listed so an existing loan shows it.
  const accountOptions: PickerOption[] = useMemo(
    () =>
      accounts
        .filter((a) => (a as Account & { isInvestment?: boolean }).isInvestment !== true || a.id === form.accountId)
        .map((a) => ({ id: a.id, label: safeAccountName(a), sublabel: a.currency })),
    [accounts, form.accountId],
  );
  const linkedAccount = form.accountId ? accounts.find((a) => a.id === form.accountId) : null;
  const interest = LOAN_INTEREST_OPTIONS.find((o) => o.value === form.interestMethod) ?? LOAN_INTEREST_OPTIONS[0];

  const pickAccount = (id: number) => {
    const acct = accounts.find((a) => a.id === id);
    // A NEW loan takes its account's currency; an existing loan keeps its own.
    setForm((prev) => ({
      ...prev,
      accountId: id,
      currency: !isEdit && acct?.currency ? acct.currency : prev.currency,
    }));
  };

  const save = async () => {
    const built = buildLoanPayload(form);
    if (!built.ok) return;
    setSaving(true);
    try {
      const res =
        isEdit && editLoan
          ? await endpoints.updateLoan({ id: editLoan.id, ...built.body })
          : await endpoints.createLoan(built.body);
      if (res.success) {
        logger.info("add-loan", isEdit ? "updated" : "created", { method: form.interestMethod });
        navigation.goBack();
      } else {
        logger.warn("add-loan", "save rejected", { error: res.error });
        Alert.alert("Couldn't save", res.error || "Please try again.");
      }
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error("add-loan", "save threw", { detail });
      Alert.alert("Error", "Cannot connect to server");
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => {
    // One save at a time: /api/loans has no idempotency key.
    if (saving) return;
    const built = buildLoanPayload(form);
    if (!built.ok) {
      Alert.alert("Check the form", built.error);
      return;
    }
    // Changing the currency re-labels the loan's amounts; it does not convert them.
    if (isEdit && editLoan && built.body.currency !== editLoan.currency) {
      Alert.alert(
        `Change the currency to ${built.body.currency}?`,
        `The loan's amounts stay the same numbers and are read as ${built.body.currency} instead of ${editLoan.currency}. Nothing is converted.`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Change", onPress: () => void save() },
        ],
      );
      return;
    }
    void save();
  };

  const handleDelete = () => {
    if (!editLoan) return;
    Alert.alert(
      "Delete loan?",
      `Delete "${safeName(editLoan.name, "this loan")}"? Its account and your transactions are not affected.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setDeleting(true);
            try {
              const res = await endpoints.deleteLoan(editLoan.id);
              // Back to the list: the loan's own screen has nothing left to show.
              if (res.success) navigation.navigate("Loans");
              else Alert.alert("Couldn't delete", res.error || "Please try again.");
            } catch (e) {
              const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
              logger.error("add-loan", "delete threw", { detail });
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

  const field = (
    label: string,
    key: keyof LoanFormState,
    opts: { placeholder?: string; numeric?: boolean; integer?: boolean; autoFocus?: boolean; last?: boolean } = {},
  ) => (
    <View style={[fieldStyles.container, opts.last ? { marginBottom: 0 } : null]}>
      <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        style={input}
        value={form[key] as string}
        onChangeText={(v) => set(key, v as never)}
        keyboardType={opts.integer ? "number-pad" : opts.numeric ? "decimal-pad" : "default"}
        placeholder={opts.placeholder}
        placeholderTextColor={colors.mutedForeground}
        autoCapitalize="none"
        autoFocus={opts.autoFocus}
      />
    </View>
  );

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => navigation.goBack()}>
            <Text style={[styles.backBtn, { color: colors.primary }]}>Cancel</Text>
          </TouchableOpacity>
          <Text style={[styles.title, { color: colors.foreground }]}>{isEdit ? "Edit loan" : "New loan"}</Text>
          <TouchableOpacity onPress={handleSave} disabled={saving} accessibilityRole="button" accessibilityLabel="Save">
            {saving ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Text style={[styles.saveBtn, { color: colors.primary }]}>Save</Text>
            )}
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {field("NAME", "name", { placeholder: "e.g. Car loan, mortgage", autoFocus: !isEdit })}

            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>TYPE</Text>
              {chips(LOAN_TYPE_OPTIONS, form.type, (v) => set("type", v))}
            </View>

            {field("AMOUNT BORROWED", "principal", { placeholder: "0.00", numeric: true })}

            <View style={[fieldStyles.container, { marginBottom: 0 }]}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>CURRENCY</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {chips(currencyOptions.map((c) => ({ value: c, label: c })), form.currency, (v) => set("currency", v))}
              </ScrollView>
            </View>
          </View>

          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>INTEREST</Text>
              {chips(LOAN_INTEREST_OPTIONS, form.interestMethod, (v) => set("interestMethod", v))}
              <Text style={[fieldStyles.hint, { color: colors.mutedForeground }]}>{interest.hint}</Text>
            </View>
            {form.interestMethod === "rate"
              ? field(interest.field, "annualRate", { placeholder: "0.00", numeric: true, last: true })
              : field(interest.field, "interestAmount", { placeholder: "0.00", numeric: true, last: true })}
          </View>

          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[fieldStyles.hint, { color: colors.mutedForeground, marginTop: 0, marginBottom: 12 }]}>
              Enter the term or the payment. With one, the other is worked out.
            </Text>
            {field("TERM (MONTHS)", "termMonths", { placeholder: "From the payment", integer: true })}
            {field("PAYMENT", "paymentAmount", { placeholder: "From the term", numeric: true })}

            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>HOW OFTEN</Text>
              {chips(LOAN_FREQUENCY_OPTIONS, form.paymentFrequency, (v) => set("paymentFrequency", v))}
            </View>

            {field("EXTRA WITH EACH PAYMENT (OPTIONAL)", "extraPayment", { placeholder: "0.00", numeric: true })}
            {form.type === "lease"
              ? field("BUYOUT AT THE END (OPTIONAL)", "residualValue", { placeholder: "0.00", numeric: true })
              : null}
            {field("START DATE (YYYY-MM-DD)", "startDate", { placeholder: "2026-10-15", last: true })}
          </View>

          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={[fieldStyles.container, { marginBottom: 0 }]}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>LINKED ACCOUNT (OPTIONAL)</Text>
              <View style={fieldStyles.selectRow}>
                <TouchableOpacity
                  style={[input, fieldStyles.selectBox]}
                  onPress={() => setAccountPickerOpen(true)}
                  accessibilityRole="button"
                  accessibilityLabel="Linked account"
                >
                  <Text style={{ color: linkedAccount ? colors.foreground : colors.mutedForeground, fontSize: 15 }} numberOfLines={1}>
                    {linkedAccount ? safeAccountName(linkedAccount) : form.accountId ? `Account #${form.accountId}` : "None"}
                  </Text>
                </TouchableOpacity>
                {form.accountId ? (
                  <TouchableOpacity onPress={() => set("accountId", null)} style={fieldStyles.clearBtn} hitSlop={8}>
                    <Text style={{ color: colors.mutedForeground, fontWeight: "600" }}>Clear</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
              <Text style={[fieldStyles.hint, { color: colors.mutedForeground }]}>
                The account this loan is tracked on. Its balance becomes what you owe, and the loan&apos;s interest is
                booked there.
              </Text>
            </View>
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
                <Text style={[styles.deleteText, { color: colors.destructive }]}>Delete loan</Text>
              )}
            </TouchableOpacity>
          )}
        </ScrollView>

        <PickerSheet
          visible={accountPickerOpen}
          title="Linked account"
          options={accountOptions}
          selectedId={form.accountId}
          onSelect={pickAccount}
          onClose={() => setAccountPickerOpen(false)}
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
  hint: { fontSize: 12, lineHeight: 17, marginTop: 6 },
  input: { fontSize: 15, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  chipWrap: { flexDirection: "row", flexWrap: "wrap" },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, marginRight: 8, marginBottom: 8 },
  chipText: { fontSize: 13, fontWeight: "600" },
  selectRow: { flexDirection: "row", alignItems: "center" },
  selectBox: { flex: 1, justifyContent: "center", minHeight: 42 },
  clearBtn: { paddingHorizontal: 10, paddingVertical: 8 },
});
