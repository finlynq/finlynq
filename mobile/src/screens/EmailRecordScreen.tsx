// One emailed transaction. The email itself comes first (owner feedback
// 2026-10-15: "I need to see the email, same as on the web, to know what it is
// for"), then what was read from it and why it may need a closer look, then the
// record form: pick the account, then a category or a transfer destination; the
// amount, date and payee can be corrected first. An amount whose sign is
// unusual for the category (a refund in an expense category) is recorded with a
// warning, never refused. An email already recorded (or one with no amount in
// it) opens read-only.

import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { formatCurrency, safeAccountName, safeName } from "../lib/format";
import { PickerSheet, type PickerOption } from "../components/picker-sheet";
import { DateField } from "../components/DateField";
import {
  buildEmailRecordBody,
  emailBodyText,
  emailFormInit,
  emailStatus,
  emailStatusLabel,
  flipAmountSign,
  reviewReasons,
  type EmailRecordForm,
} from "../lib/email-imports";
import type { Category, EmailInboxDetail, InboxAccount } from "../../../shared/types";
import type { MoreStackParamList } from "../navigation/MoreStack";

type Picker = "account" | "category" | "dest" | null;

export default function EmailRecordScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation();
  const { item } = useRoute<RouteProp<MoreStackParamList, "EmailRecord">>().params;
  const candidate = item.candidate;
  // Only a bank-alert email still under review, with an amount read from it,
  // can be recorded; anything else opens read-only.
  const recordable = item.action === "needs_review" && item.sourceKind === "body" && candidate != null;
  const canDiscard =
    item.sourceKind === "body" && !["auto_recorded", "manually_recorded", "duplicate_skipped", "discarded"].includes(item.action);
  const [form, setForm] = useState<EmailRecordForm>(() =>
    emailFormInit(candidate ?? { date: "", amount: 0, currency: "USD", payee: "" }),
  );
  const [detail, setDetail] = useState<EmailInboxDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [wholeEmail, setWholeEmail] = useState(false);
  const [accounts, setAccounts] = useState<InboxAccount[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [picker, setPicker] = useState<Picker>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the server held it back as a possible duplicate.
  const [duplicateOf, setDuplicateOf] = useState<number | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    Promise.all([endpoints.getInboxAccounts(), endpoints.getCategories()])
      .then(([a, c]) => {
        if (!alive) return;
        if (a.success) setAccounts(Array.isArray(a.data) ? a.data : []);
        if (c.success) setCategories(Array.isArray(c.data) ? c.data : []);
      })
      .catch((e) => logger.error("email-record", "lookups threw", { detail: String(e) }));
    return () => {
      alive = false;
    };
  }, []);

  // The email itself (subject, sender, body) and what the parser read from it.
  useEffect(() => {
    let alive = true;
    endpoints
      .getEmailInboxItem(item.id)
      .then((res) => {
        if (!alive) return;
        if (res.success) setDetail(res.data);
        else setDetailError(res.error);
      })
      .catch((e) => {
        logger.error("email-record", "detail threw", { detail: String(e) });
        if (alive) setDetailError("Cannot connect to server");
      });
    return () => {
      alive = false;
    };
  }, [item.id]);

  // An email records into a plain account; the body surface has no holding.
  const accountOptions: PickerOption[] = useMemo(
    () =>
      accounts
        .filter((a) => !a.archived && a.isInvestment !== true)
        .map((a) => ({ id: a.id, label: safeAccountName(a), sublabel: a.currency })),
    [accounts],
  );
  const categoryOptions: PickerOption[] = useMemo(
    () =>
      // Every category, as on the web tab.
      categories.map((c) => ({
        id: c.id,
        label: safeName(c.name),
        sublabel: `${c.type === "I" ? "Income" : c.type === "R" ? "Transfer" : "Expense"} · ${c.group}`,
      })),
    [categories],
  );
  const labelOf = (opts: PickerOption[], id: number | null) => opts.find((o) => o.id === id)?.label ?? null;
  const set = (patch: Partial<EmailRecordForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setError(null);
    setDuplicateOf(undefined);
  };

  const record = async (force = false) => {
    if (!recordable || !candidate) return;
    const built = buildEmailRecordBody(candidate, form, { force });
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await endpoints.recordEmail(item.id, built.body);
      if (!res.success) {
        setError(res.error);
        return;
      }
      const r = res.data;
      if (r.action === "possible_duplicate") {
        setDuplicateOf(r.duplicateOfTransactionId ?? null);
        return;
      }
      if (r.action === "duplicate_skipped") {
        Alert.alert("Already recorded", "This transaction is already in the account, so nothing was added.");
      } else if (r.warning) {
        Alert.alert("Recorded", r.warning);
      }
      navigation.goBack();
    } catch (e) {
      logger.error("email-record", "record threw", { detail: String(e) });
      setError("Cannot connect to server");
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    Alert.alert("Discard this email?", "It is removed from the list and nothing is recorded.", [
      { text: "Keep", style: "cancel" },
      {
        text: "Discard",
        style: "destructive",
        onPress: async () => {
          const res = await endpoints.discardEmail(item.id);
          if (res.success) navigation.goBack();
          else setError(res.error);
        },
      },
    ]);
  };

  const select = (label: string, value: string | null, onPress: () => void, placeholder: string) => (
    <View style={fieldStyles.container}>
      <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>{label}</Text>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value ?? "none"}`}
        onPress={onPress}
        style={[fieldStyles.input, { backgroundColor: colors.secondary, borderColor: colors.border }]}
      >
        <Text style={{ color: value ? colors.foreground : colors.mutedForeground, fontSize: 15 }}>{value ?? placeholder}</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => navigation.goBack()}>
            <Text style={[styles.backBtn, { color: colors.primary }]}>{recordable ? "Cancel" : "Close"}</Text>
          </TouchableOpacity>
          <Text style={[styles.title, { color: colors.foreground }]}>{recordable ? "Record email" : "Email"}</Text>
          {recordable ? (
            <TouchableOpacity onPress={() => record(false)} disabled={saving} accessibilityRole="button" accessibilityLabel="Record">
              {saving ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <Text style={[styles.saveBtn, { color: colors.primary }]}>Record</Text>
              )}
            </TouchableOpacity>
          ) : (
            <View style={styles.topBarSpacer} />
          )}
        </View>

        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          {/* The email, as it arrived. */}
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.subject, { color: colors.foreground }]} selectable>
              {safeName(item.subject, "(no subject)")}
            </Text>
            <Text style={[styles.from, { color: colors.mutedForeground }]} selectable>
              {safeName(item.fromAddress, "unknown sender")} · {item.receivedAt.slice(0, 10)}
            </Text>
            {!recordable && (
              <Text style={[styles.status, { color: colors.mutedForeground }]}>
                {emailStatusLabel(emailStatus(item, new Set()) ?? "recorded")}
                {item.recordedTransactionId ? ` (transaction #${item.recordedTransactionId})` : ""}
              </Text>
            )}
            <View style={[styles.bodyBox, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
              {detail ? (
                <>
                  <Text
                    style={[styles.body, { color: colors.foreground }]}
                    numberOfLines={wholeEmail ? undefined : 16}
                    selectable
                  >
                    {emailBodyText(detail.bodyText, detail.bodyHtml) || "(this email has no text)"}
                  </Text>
                  <TouchableOpacity onPress={() => setWholeEmail((w) => !w)} accessibilityRole="button" style={styles.moreBtn}>
                    <Text style={{ color: colors.primary, fontWeight: "600", fontSize: 13 }}>
                      {wholeEmail ? "Show less" : "Show the whole email"}
                    </Text>
                  </TouchableOpacity>
                </>
              ) : detailError ? (
                <Text style={[styles.body, { color: colors.destructive }]}>{detailError}</Text>
              ) : (
                <ActivityIndicator size="small" color={colors.primary} />
              )}
            </View>
            {item.sourceKind === "attachment" && (
              <Text style={[styles.from, { color: colors.mutedForeground, marginTop: 8 }]}>
                This email carried a statement file. Its rows are reviewed as a file, not recorded one by one.
              </Text>
            )}
          </View>

          {/* What was read from it, and why it may need a closer look (the web tab's panel). */}
          {candidate && (
            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>WHAT WE READ</Text>
              <Text style={[styles.readLine, { color: colors.foreground }]}>
                {formatCurrency(candidate.amount, candidate.currency)}
                <Text style={{ color: colors.mutedForeground }}>
                  {candidate.amount < 0 ? " · money out" : " · money in"}
                  {detail?.signals && !detail.signals.signExplicit ? " (assumed)" : ""}
                  {detail?.candidate?.last4 ? ` · card ending ${detail.candidate.last4}` : ""}
                </Text>
              </Text>
              <Text style={[styles.readLine, { color: colors.foreground }]}>{safeName(candidate.payee, "Unknown payee")}</Text>
              <Text style={[styles.readLine, { color: colors.foreground }]}>
                {candidate.date}
                {detail?.signals?.usedFallbackDate ? (
                  <Text style={{ color: colors.mutedForeground }}> · the date it arrived</Text>
                ) : null}
              </Text>
              {(() => {
                const reasons = reviewReasons(candidate, detail?.signals, (v, c) => formatCurrency(v, c));
                if (reasons.length === 0) return null;
                return (
                  <View style={styles.reasons}>
                    <Text style={[styles.reasonHead, { color: colors.destructive }]}>Why this needs a look</Text>
                    {reasons.map((r) => (
                      <Text key={r} style={[styles.reason, { color: colors.foreground }]}>
                        • {r}
                      </Text>
                    ))}
                  </View>
                );
              })()}
            </View>
          )}

          {recordable && candidate && (
          <>
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>AMOUNT ({candidate.currency})</Text>
              <View style={styles.amountRow}>
                <TextInput
                  style={[fieldStyles.input, styles.amountInput, { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border }]}
                  value={form.amount}
                  onChangeText={(t) => set({ amount: t })}
                  keyboardType="numbers-and-punctuation"
                  accessibilityLabel="Amount"
                />
                <TouchableOpacity
                  onPress={() => set({ amount: flipAmountSign(form.amount) })}
                  style={[styles.flipBtn, { borderColor: colors.border }]}
                  accessibilityRole="button"
                  accessibilityLabel="Flip sign"
                >
                  <Text style={{ color: colors.primary, fontWeight: "700" }}>±</Text>
                </TouchableOpacity>
              </View>
              <Text style={[fieldStyles.hint, { color: colors.mutedForeground }]}>Money out is negative, money in positive.</Text>
            </View>
            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>DATE</Text>
              <DateField
                title="Date"
                value={form.date}
                onChange={(d) => set({ date: d })}
                style={[fieldStyles.input, { backgroundColor: colors.secondary, borderColor: colors.border }]}
              />
            </View>
            <View style={[fieldStyles.container, { marginBottom: 0 }]}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>PAYEE</Text>
              <TextInput
                style={[fieldStyles.input, { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border }]}
                value={form.payee}
                onChangeText={(t) => set({ payee: t })}
                accessibilityLabel="Payee"
              />
            </View>
          </View>

          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {select("ACCOUNT", labelOf(accountOptions, form.accountId), () => setPicker("account"), "Choose an account")}
            <View style={styles.modeRow}>
              {(["category", "transfer"] as const).map((m) => (
                <TouchableOpacity
                  key={m}
                  onPress={() => set({ mode: m })}
                  accessibilityRole="button"
                  accessibilityState={{ selected: form.mode === m }}
                  style={[
                    styles.modeBtn,
                    { borderColor: colors.border },
                    form.mode === m && { backgroundColor: colors.accent, borderColor: colors.primary },
                  ]}
                >
                  <Text style={{ color: colors.foreground, fontWeight: "600" }}>{m === "category" ? "Category" : "Transfer"}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {form.mode === "category"
              ? select("CATEGORY", labelOf(categoryOptions, form.categoryId), () => setPicker("category"), "Choose a category")
              : select("TRANSFER TO", labelOf(accountOptions, form.destAccountId), () => setPicker("dest"), "Choose the other account")}
          </View>

          {error && <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text>}
          {duplicateOf !== undefined && (
            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={{ color: colors.foreground, fontSize: 14, lineHeight: 20 }}>
                This looks like a transaction already in the account
                {duplicateOf != null ? ` (#${duplicateOf})` : ""}, so it was not recorded.
              </Text>
              <TouchableOpacity onPress={() => record(true)} disabled={saving} accessibilityRole="button" style={styles.linkBtn}>
                <Text style={{ color: colors.primary, fontWeight: "700" }}>Record anyway</Text>
              </TouchableOpacity>
            </View>
          )}
          </>
          )}
          {!recordable && error && <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text>}

          {canDiscard && (
            <TouchableOpacity onPress={discard} accessibilityRole="button" style={styles.discard}>
              <Text style={{ color: colors.destructive, fontWeight: "600" }}>Discard this email</Text>
            </TouchableOpacity>
          )}
        </ScrollView>

        <PickerSheet
          visible={picker != null}
          title={picker === "category" ? "Category" : picker === "dest" ? "Transfer to" : "Account"}
          options={picker === "category" ? categoryOptions : accountOptions}
          selectedId={picker === "category" ? form.categoryId : picker === "dest" ? form.destAccountId : form.accountId}
          onSelect={(id) =>
            picker === "category"
              ? set({ categoryId: id })
              : picker === "dest"
                ? set({ destAccountId: id })
                : set({ accountId: id })
          }
          onClose={() => setPicker(null)}
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
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: { fontSize: 15, fontWeight: "600" },
  title: { fontSize: 17, fontWeight: "700" },
  saveBtn: { fontSize: 15, fontWeight: "700" },
  scroll: { padding: 16, paddingBottom: 32 },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 16, marginBottom: 12 },
  from: { fontSize: 13, lineHeight: 18 },
  topBarSpacer: { width: 52 },
  subject: { fontSize: 16, fontWeight: "700", marginBottom: 2 },
  status: { fontSize: 13, fontWeight: "600", marginTop: 6 },
  bodyBox: { marginTop: 10, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, padding: 10 },
  body: { fontSize: 13, lineHeight: 19 },
  moreBtn: { marginTop: 8 },
  readLine: { fontSize: 14, lineHeight: 21 },
  reasons: { marginTop: 8 },
  reasonHead: { fontSize: 12, fontWeight: "700", marginBottom: 2 },
  reason: { fontSize: 13, lineHeight: 19 },
  amountRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  amountInput: { flex: 1 },
  flipBtn: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 9 },
  modeRow: { flexDirection: "row", gap: 8, marginBottom: 16 },
  modeBtn: { flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth },
  error: { fontSize: 14, marginBottom: 12 },
  linkBtn: { marginTop: 10 },
  discard: { alignItems: "center", paddingVertical: 12 },
});

const fieldStyles = StyleSheet.create({
  container: { marginBottom: 16 },
  label: { fontSize: 12, fontWeight: "600", marginBottom: 6 },
  hint: { fontSize: 12, lineHeight: 17, marginTop: 6 },
  input: { fontSize: 15, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
});
