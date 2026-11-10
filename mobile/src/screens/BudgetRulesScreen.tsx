// A budget line's rules (web plan/budget-rules.md): an amount from a start
// month to an optional end month, optionally rising every month or every year.
// A month's budget is the rules active that month plus anything typed on top.
// Rules fill this month and later; months that have ended keep their budgets,
// whatever is changed here. The server works out every amount.
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { formatCurrency, safeName } from "../lib/format";
import { Icon } from "../components/icon";
import {
  addMonths,
  describeIncrease,
  isMissingRoute,
  monthName,
  parseBudgetAmount,
  parseSignedAmount,
  ruleRange,
  shortMonth,
  type BudgetRule,
  type BudgetRuleInput,
  type LineRulesView,
} from "../lib/budgets";
import type { MoreStackParamList } from "../navigation/MoreStack";

type Props = NativeStackScreenProps<MoreStackParamList, "BudgetRules">;

const NETWORK_ERROR = "Cannot connect to server";
export const RULES_ROUTE_MISSING = "Budget rules need a newer Finlynq server. Update the server this app connects to, then try again.";

interface Draft {
  id: number | null;
  amount: string;
  startMonth: string;
  noEnd: boolean;
  endMonth: string;
  incMode: "none" | "percent" | "amount";
  incValue: string;
  every: "month" | "year";
  stepMonth: number;
}

export const emptyRuleDraft = (start: string): Draft => ({
  id: null,
  amount: "",
  startMonth: start,
  noEnd: true,
  endMonth: start,
  incMode: "none",
  incValue: "",
  every: "year",
  stepMonth: 1,
});

export const ruleToDraft = (r: BudgetRule): Draft => ({
  id: r.id,
  amount: String(r.amount),
  startMonth: r.startMonth,
  noEnd: r.endMonth == null,
  endMonth: r.endMonth ?? r.startMonth,
  incMode: r.increase ? r.increase.mode : "none",
  incValue: r.increase ? String(r.increase.value) : "",
  every: r.increase?.every ?? "year",
  stepMonth: r.increase?.stepMonth ?? 1,
});

/** The draft as the server takes it, or the reason it can't be saved. */
export function draftToInput(d: Draft): BudgetRuleInput | { error: string } {
  const amount = parseBudgetAmount(d.amount);
  if (amount === "invalid" || amount == null) return { error: "Enter an amount of 0 or more." };
  const value = parseSignedAmount(d.incValue);
  if (d.incMode !== "none" && (value === "invalid" || value == null)) return { error: "Enter the increase." };
  if (!d.noEnd && d.endMonth < d.startMonth) return { error: "The end month is before the start month." };
  const increase =
    d.incMode === "none" || !value || value === "invalid"
      ? null
      : { mode: d.incMode, value, every: d.every, ...(d.every === "year" ? { stepMonth: d.stepMonth } : {}) };
  return { amount, startMonth: d.startMonth, endMonth: d.noEnd ? null : d.endMonth, increase };
}

export default function BudgetRulesScreen({ navigation, route }: Props) {
  const { colors } = useTheme();
  const { lineKey, name, month } = route.params;
  const [view, setView] = useState<LineRulesView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await endpoints.getBudgetRules(lineKey, month);
      if (!res.success || !res.data) {
        const message = res.success ? "Couldn't load the rules" : res.error;
        setLoadError(isMissingRoute(message) ? RULES_ROUTE_MISSING : message || "Couldn't load the rules");
        return;
      }
      setView(res.data);
      setLoadError(null);
    } catch {
      setLoadError(NETWORK_ERROR);
    }
  }, [lineKey, month]);

  useEffect(() => {
    void load();
  }, [load]);

  const cur = view?.currency ?? "";
  const fmt = (n: number) => formatCurrency(n, cur);

  const save = async () => {
    if (!draft || busy) return;
    const input = draftToInput(draft);
    if ("error" in input) {
      setError(input.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = draft.id == null ? await endpoints.createBudgetRule(lineKey, input) : await endpoints.updateBudgetRule(draft.id, input);
      if (!res.success) {
        setError(res.error || "Couldn't save the rule.");
        return;
      }
      setDraft(null);
      await load();
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setBusy(false);
    }
  };

  const remove = (rule: BudgetRule) => {
    Alert.alert("Delete this rule?", "This month and later stop getting its amount. Months that have ended keep their budgets.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          setError(null);
          try {
            const res = await endpoints.deleteBudgetRule(rule.id);
            if (!res.success) setError(res.error || "Couldn't delete the rule.");
            else {
              if (draft?.id === rule.id) setDraft(null);
              await load();
            }
          } catch {
            setError(NETWORK_ERROR);
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  const chip = (label: string, on: boolean, onPress: () => void) => (
    <TouchableOpacity
      key={label}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={[styles.chip, { borderColor: on ? colors.primary : colors.border, backgroundColor: on ? colors.primary : "transparent" }]}
    >
      <Text style={[styles.chipText, { color: on ? colors.primaryForeground : colors.foreground }]}>{label}</Text>
    </TouchableOpacity>
  );

  const stepper = (label: string, text: string, onPrev: () => void, onNext: () => void) => (
    <View style={styles.stepper}>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Earlier ${label}`} onPress={onPrev} hitSlop={8} style={styles.stepBtn}>
        <Icon name="chevronLeft" size={18} color={colors.primary} />
      </TouchableOpacity>
      <Text style={[styles.stepText, { color: colors.foreground }]} accessibilityLabel={`${label} ${text}`}>
        {text}
      </Text>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Later ${label}`} onPress={onNext} hitSlop={8} style={styles.stepBtn}>
        <Icon name="chevronRight" size={18} color={colors.primary} />
      </TouchableOpacity>
    </View>
  );

  const input = (value: string, onChange: (t: string) => void, label: string, placeholder: string, signed = false) => (
    <TextInput
      accessibilityLabel={label}
      value={value}
      onChangeText={onChange}
      keyboardType={signed ? "numbers-and-punctuation" : "decimal-pad"}
      placeholder={placeholder}
      placeholderTextColor={colors.mutedForeground}
      style={[styles.input, { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border }]}
    />
  );

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()} accessibilityRole="button" accessibilityLabel="Back to budgets">
          <Icon name="back" size={20} color={colors.primary} />
          <Text style={[styles.backText, { color: colors.primary }]}>Budgets</Text>
        </TouchableOpacity>
        <View style={styles.titleWrap}>
          <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
            Budget rules
          </Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]} numberOfLines={1}>
            {safeName(name)}
          </Text>
        </View>
        <View style={{ width: 70 }} />
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={[styles.lead, { color: colors.mutedForeground }]}>
          Each month&apos;s budget is the rules active that month plus anything you type on top. Rules fill this month and later; months that
          have ended keep their budgets, whatever you change here.
        </Text>

        {loadError ? <Text style={[styles.error, { color: colors.destructive }]}>{loadError}</Text> : null}
        {!view && !loadError ? <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} /> : null}

        {view ? (
          <>
            {view.rules.length === 0 && !draft ? (
              <Text style={[styles.muted, { color: colors.mutedForeground }]}>No rules yet.</Text>
            ) : null}
            {view.rules.map((r) => (
              <View key={r.id} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={styles.cardMain}>
                  <Text style={[styles.cardTitle, { color: colors.foreground }]}>
                    {formatCurrency(r.amount, r.currency)} a month
                    {r.increase ? <Text style={{ color: colors.mutedForeground }}>{` · ${describeIncrease(r.increase, fmt)}`}</Text> : null}
                  </Text>
                  <Text style={[styles.cardMeta, { color: colors.mutedForeground }]}>
                    {ruleRange(r.startMonth, r.endMonth)}
                    {r.fromMonthAmount != null ? ` · ${shortMonth(view.from)}: ${fmt(r.fromMonthAmount)}` : ""}
                  </Text>
                </View>
                <TouchableOpacity accessibilityRole="button" accessibilityLabel="Edit rule" onPress={() => { setError(null); setDraft(ruleToDraft(r)); }} hitSlop={8} style={styles.iconBtn}>
                  <Icon name="edit" size={16} color={colors.mutedForeground} />
                </TouchableOpacity>
                <TouchableOpacity accessibilityRole="button" accessibilityLabel="Delete rule" onPress={() => remove(r)} hitSlop={8} style={styles.iconBtn}>
                  <Icon name="trash" size={16} color={colors.mutedForeground} />
                </TouchableOpacity>
              </View>
            ))}

            {draft ? (
              <View style={[styles.card, styles.form, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Text style={[styles.cardTitle, { color: colors.foreground }]}>{draft.id == null ? "New rule" : "Edit rule"}</Text>
                <Text style={[styles.label, { color: colors.mutedForeground }]}>AMOUNT A MONTH ({cur})</Text>
                {input(draft.amount, (t) => setDraft({ ...draft, amount: t }), "Amount a month", "100")}
                <Text style={[styles.label, { color: colors.mutedForeground }]}>FROM</Text>
                {stepper(
                  "start month",
                  shortMonth(draft.startMonth),
                  () => setDraft({ ...draft, startMonth: addMonths(draft.startMonth, -1) }),
                  () => setDraft({ ...draft, startMonth: addMonths(draft.startMonth, 1) }),
                )}
                <View style={styles.switchRow}>
                  <Text style={[styles.switchLabel, { color: colors.foreground }]}>No end</Text>
                  <Switch accessibilityLabel="No end" value={draft.noEnd} onValueChange={(on) => setDraft({ ...draft, noEnd: on, endMonth: draft.endMonth < draft.startMonth ? draft.startMonth : draft.endMonth })} />
                </View>
                {!draft.noEnd ? (
                  <>
                    <Text style={[styles.label, { color: colors.mutedForeground }]}>TO</Text>
                    {stepper(
                      "end month",
                      shortMonth(draft.endMonth),
                      () => setDraft({ ...draft, endMonth: addMonths(draft.endMonth, -1) }),
                      () => setDraft({ ...draft, endMonth: addMonths(draft.endMonth, 1) }),
                    )}
                  </>
                ) : null}
                <Text style={[styles.label, { color: colors.mutedForeground }]}>INCREASE</Text>
                <View style={styles.chips}>
                  {chip("None", draft.incMode === "none", () => setDraft({ ...draft, incMode: "none" }))}
                  {chip("By a percent", draft.incMode === "percent", () => setDraft({ ...draft, incMode: "percent" }))}
                  {chip("By an amount", draft.incMode === "amount", () => setDraft({ ...draft, incMode: "amount" }))}
                </View>
                {draft.incMode !== "none" ? (
                  <>
                    {input(
                      draft.incValue,
                      (t) => setDraft({ ...draft, incValue: t }),
                      draft.incMode === "percent" ? "Percent" : "Amount",
                      draft.incMode === "percent" ? "3" : "25",
                      true,
                    )}
                    <View style={styles.chips}>
                      {chip("Every month", draft.every === "month", () => setDraft({ ...draft, every: "month" }))}
                      {chip("Every year", draft.every === "year", () => setDraft({ ...draft, every: "year" }))}
                    </View>
                    {draft.every === "year"
                      ? stepper(
                          "step month",
                          `in ${monthName(draft.stepMonth)}`,
                          () => setDraft({ ...draft, stepMonth: ((draft.stepMonth + 10) % 12) + 1 }),
                          () => setDraft({ ...draft, stepMonth: (draft.stepMonth % 12) + 1 }),
                        )
                      : null}
                    <Text style={[styles.hint, { color: colors.mutedForeground }]}>
                      Counted from the start month, never in the start month itself. A minus sign lowers.
                    </Text>
                  </>
                ) : null}
                {error ? <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text> : null}
                <View style={styles.formButtons}>
                  <TouchableOpacity accessibilityRole="button" onPress={() => setDraft(null)} style={[styles.btn, { borderColor: colors.border }]}>
                    <Text style={[styles.btnText, { color: colors.foreground }]}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={draft.id == null ? "Add rule" : "Save rule"}
                    onPress={busy ? undefined : save}
                    style={[styles.btn, { backgroundColor: colors.primary, borderColor: colors.primary, opacity: busy ? 0.6 : 1 }]}
                  >
                    {busy ? (
                      <ActivityIndicator size="small" color={colors.primaryForeground} />
                    ) : (
                      <Text style={[styles.btnText, { color: colors.primaryForeground }]}>{draft.id == null ? "Add rule" : "Save rule"}</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() => { setError(null); setDraft(emptyRuleDraft(view.from)); }}
                style={[styles.addBtn, { borderColor: colors.primary }]}
              >
                <Icon name="add" size={16} color={colors.primary} />
                <Text style={[styles.btnText, { color: colors.primary }]}>Add a rule</Text>
              </TouchableOpacity>
            )}
            {!draft && error ? <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text> : null}

            <Text style={[styles.section, { color: colors.mutedForeground }]}>Next 12 months</Text>
            <View style={[styles.table, { borderColor: colors.border, backgroundColor: colors.card }]}>
              <View style={[styles.tr, styles.th, { borderBottomColor: colors.border }]}>
                <Text style={[styles.tdMonth, styles.thText, { color: colors.mutedForeground }]}>Month</Text>
                <Text style={[styles.td, styles.thText, { color: colors.mutedForeground }]}>Rules</Text>
                <Text style={[styles.td, styles.thText, { color: colors.mutedForeground }]}>Typed</Text>
                <Text style={[styles.td, styles.thText, { color: colors.mutedForeground }]}>Budget</Text>
              </View>
              {view.months.map((m) => (
                <View key={m.month} style={[styles.tr, { borderBottomColor: colors.border }]}>
                  <Text style={[styles.tdMonth, { color: colors.foreground }]}>{shortMonth(m.month)}</Text>
                  <Text
                    style={[styles.td, { color: m.override ? colors.mutedForeground : colors.foreground, textDecorationLine: m.override ? "line-through" : "none" }]}
                  >
                    {m.fromRules ? fmt(m.fromRules) : "—"}
                  </Text>
                  <Text style={[styles.td, { color: colors.foreground }]}>
                    {m.override ? "only this" : m.adjustment ? `${m.adjustment > 0 ? "+" : ""}${fmt(m.adjustment)}` : "—"}
                  </Text>
                  <Text style={[styles.td, styles.tdStrong, { color: m.total != null && m.total < 0 ? colors.destructive : colors.foreground }]}>
                    {m.total == null ? "—" : fmt(m.total)}
                  </Text>
                </View>
              ))}
            </View>
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: { flexDirection: "row", alignItems: "center", gap: 2, width: 70 },
  backText: { fontSize: 15, fontWeight: "600" },
  titleWrap: { flex: 1, alignItems: "center" },
  title: { fontSize: 17, fontWeight: "700" },
  subtitle: { fontSize: 12, marginTop: 1 },
  body: { padding: 16, paddingBottom: 40 },
  lead: { fontSize: 13, lineHeight: 19, marginBottom: 14 },
  muted: { fontSize: 14, marginBottom: 10 },
  error: { fontSize: 13, marginVertical: 8 },
  card: { flexDirection: "row", alignItems: "center", borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 12, marginBottom: 8 },
  cardMain: { flex: 1, marginRight: 8 },
  cardTitle: { fontSize: 15, fontWeight: "700" },
  cardMeta: { fontSize: 12, marginTop: 2 },
  iconBtn: { padding: 6 },
  form: { flexDirection: "column", alignItems: "stretch" },
  label: { fontSize: 11, fontWeight: "700", letterSpacing: 0.5, marginTop: 12, marginBottom: 6 },
  input: { fontSize: 16, fontWeight: "600", borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  stepper: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4 },
  stepBtn: { padding: 6 },
  stepText: { fontSize: 15, fontWeight: "600" },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 10 },
  switchLabel: { fontSize: 14, flex: 1 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8, marginBottom: 4 },
  chip: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  chipText: { fontSize: 13, fontWeight: "600" },
  hint: { fontSize: 12, marginTop: 8, lineHeight: 17 },
  formButtons: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 14 },
  btn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10, minWidth: 90, alignItems: "center" },
  btnText: { fontSize: 14, fontWeight: "700" },
  addBtn: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: 6, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, marginTop: 4 },
  section: { fontSize: 12, fontWeight: "700", textTransform: "uppercase", marginTop: 22, marginBottom: 8 },
  table: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, overflow: "hidden" },
  tr: { flexDirection: "row", paddingHorizontal: 10, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  th: {},
  thText: { fontSize: 11, fontWeight: "700" },
  tdMonth: { flex: 1.1, fontSize: 13 },
  td: { flex: 1, fontSize: 13, textAlign: "right", fontVariant: ["tabular-nums"] },
  tdStrong: { fontWeight: "700" },
});
