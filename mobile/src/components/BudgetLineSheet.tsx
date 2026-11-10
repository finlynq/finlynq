// What a tap on a budget line opens: set the month's budget, and the line's
// other choices. The list stays short because they all live here.
//
// The sheet sits at the top of the screen, as the loan schedule's does, so the
// keyboard never covers the field.
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { formatCurrency } from "../lib/format";
import { Icon } from "./icon";
import {
  formatMonthLabel,
  parseBudgetAmount,
  parseSignedAmount,
  ruleMade,
  type BudgetSettingsChange,
  type BudgetTarget,
} from "../lib/budgets";

interface ApiResult {
  success: boolean;
  error?: string;
}

export function BudgetLineSheet({
  target,
  month,
  currency,
  onClose,
  onChanged,
  onSeeSpending,
  onOpenRules,
}: {
  /** Null hides the sheet. */
  target: BudgetTarget | null;
  month: string;
  currency: string;
  onClose: () => void;
  /** Reloads the month after a write; the sheet stays busy until it has. */
  onChanged: () => Promise<void>;
  onSeeSpending: (categoryId: number, name: string) => void;
  /** Opens the line's budget rules; absent on a server without them. */
  onOpenRules?: (key: string, name: string) => void;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState("");
  const [adjText, setAdjText] = useState("");
  const [useOnly, setUseOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const targetKey = target?.key ?? null;
  const seed = target?.budgeted ?? null;
  const plan = target?.plan ?? null;
  // Seeded when a line opens, not on each reload, so a toggle saved in the sheet
  // never overwrites what is being typed.
  useEffect(() => {
    setText(seed == null ? "" : String(seed));
    setAdjText(plan && plan.adjustment ? String(plan.adjustment) : "");
    setUseOnly(!!plan?.override);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  if (!target) return null;

  const fmt = (n: number) => formatCurrency(n, currency);
  const income = target.section === "income";
  const canBudget = !target.inGroupBudget;
  const canRoll = canBudget && !income;

  // Every write goes through here: one at a time, and a refusal or a dropped
  // connection keeps the sheet open with what was typed.
  const write = async (work: () => Promise<ApiResult>, closeAfter: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await work();
      if (!res.success) {
        setError(res.error || "Couldn't save. Please try again.");
        return;
      }
      await onChanged();
      if (closeAfter) onClose();
    } catch {
      setError("Cannot connect to server");
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    const amount = parseBudgetAmount(text);
    if (amount === "invalid") {
      setError("Enter 0 or more, or leave it empty for no budget.");
      return;
    }
    void write(() => endpoints.setBudgetLine(target.key, month, amount), true);
  };

  // An open month the line's rules make: what the rules give, plus what is
  // typed on top, or "use only this amount". The server works out the total.
  const rulesMake = canBudget && ruleMade(plan);
  const fromRules = plan?.fromRules ?? 0;
  const adjParsed = parseSignedAmount(adjText);
  const onlyParsed = parseBudgetAmount(text);
  const shownTotal = useOnly
    ? onlyParsed === "invalid" || onlyParsed == null
      ? null
      : onlyParsed
    : adjParsed === "invalid"
      ? null
      : fromRules + (adjParsed ?? 0);

  const saveRuleMonth = () => {
    if (useOnly) {
      if (onlyParsed === "invalid" || onlyParsed == null) {
        setError("Enter the amount to use this month.");
        return;
      }
      void write(() => endpoints.adjustBudget(target.key, month, { override: onlyParsed }), true);
      return;
    }
    if (adjParsed === "invalid") {
      setError("Enter an amount, with a minus sign to take off.");
      return;
    }
    void write(
      () => endpoints.adjustBudget(target.key, month, { ...(plan?.override ? { override: null } : {}), adjustment: adjParsed }),
      true,
    );
  };

  const settings = (change: Omit<BudgetSettingsChange, "target" | "month">, closeAfter = false) => {
    const settingsTarget = target.group != null ? { group: target.group } : { categoryId: target.categoryId as number };
    void write(() => endpoints.setBudgetSettings({ target: settingsTarget, month, ...change }), closeAfter);
  };

  const facts = [
    target.actual !== 0 ? `${income ? "Received" : "Spent"} ${fmt(target.actual)}` : null,
    target.carriedIn ? `Carried in ${fmt(target.carriedIn)}` : null,
  ].filter(Boolean);

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={[styles.sheet, { backgroundColor: colors.card, borderColor: colors.border, paddingTop: insets.top + 12 }]}
          onPress={() => {}}
        >
          <View style={styles.header}>
            <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={2}>
              {target.name}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityRole="button" accessibilityLabel="Close">
              <Icon name="close" size={20} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>
          {facts.length > 0 ? (
            <Text style={[styles.facts, { color: colors.mutedForeground }]}>{facts.join(" · ")}</Text>
          ) : null}

          <ScrollView keyboardShouldPersistTaps="handled" style={styles.body}>
            {rulesMake && plan ? (
              <>
                <View style={styles.ruleRow}>
                  <Text style={[styles.ruleLabel, { color: colors.mutedForeground }]}>
                    From rules{plan.ruleCount ? ` (${plan.ruleCount})` : ""}
                  </Text>
                  <Text
                    style={[
                      styles.ruleValue,
                      { color: useOnly ? colors.mutedForeground : colors.foreground, textDecorationLine: useOnly ? "line-through" : "none" },
                    ]}
                  >
                    {plan.fromRules == null ? "none this month" : fmt(fromRules)}
                  </Text>
                </View>
                {!useOnly ? (
                  <>
                    <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>ADJUSTMENT (+ ADDS, − TAKES OFF)</Text>
                    <TextInput
                      accessibilityLabel="Adjustment"
                      style={[styles.input, styles.inputFull, { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border }]}
                      value={adjText}
                      onChangeText={setAdjText}
                      keyboardType="numbers-and-punctuation"
                      placeholder="0"
                      placeholderTextColor={colors.mutedForeground}
                      autoFocus
                      onSubmitEditing={saveRuleMonth}
                    />
                  </>
                ) : null}
                <View style={styles.switchRow}>
                  <Text style={[styles.switchLabel, { color: colors.foreground }]}>Use only this amount this month (ignore the rules)</Text>
                  <Switch accessibilityLabel="Use only this amount this month" value={useOnly} disabled={busy} onValueChange={setUseOnly} />
                </View>
                {useOnly ? (
                  <TextInput
                    accessibilityLabel="Amount for this month"
                    style={[styles.input, styles.inputFull, { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border }]}
                    value={text}
                    onChangeText={setText}
                    keyboardType="decimal-pad"
                    placeholder="0"
                    placeholderTextColor={colors.mutedForeground}
                    onSubmitEditing={saveRuleMonth}
                  />
                ) : null}
                <View style={[styles.ruleRow, styles.totalRow, { borderTopColor: colors.border }]}>
                  <Text style={[styles.ruleLabel, { color: colors.foreground, fontWeight: "700" }]}>{formatMonthLabel(month)}</Text>
                  <Text
                    style={[styles.ruleValue, { color: shownTotal != null && shownTotal < 0 ? colors.destructive : colors.foreground, fontWeight: "700" }]}
                  >
                    {shownTotal == null ? "—" : fmt(shownTotal)}
                  </Text>
                </View>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Save"
                  onPress={busy ? undefined : saveRuleMonth}
                  style={[styles.saveBtn, styles.saveWide, { backgroundColor: colors.primary, opacity: busy ? 0.6 : 1 }]}
                >
                  {busy ? (
                    <ActivityIndicator size="small" color={colors.primaryForeground} />
                  ) : (
                    <Text style={[styles.saveText, { color: colors.primaryForeground }]}>Save</Text>
                  )}
                </TouchableOpacity>
              </>
            ) : canBudget ? (
              <>
                <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>
                  {income ? "EXPECTED" : "BUDGET"} FOR {formatMonthLabel(month).toUpperCase()} ({currency})
                </Text>
                <View style={styles.inputRow}>
                  <TextInput
                    accessibilityLabel={income ? "Expected amount" : "Budget amount"}
                    style={[
                      styles.input,
                      { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border },
                    ]}
                    value={text}
                    onChangeText={setText}
                    keyboardType="decimal-pad"
                    placeholder="No budget"
                    placeholderTextColor={colors.mutedForeground}
                    autoFocus
                    onSubmitEditing={save}
                  />
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel="Save budget"
                    onPress={busy ? undefined : save}
                    style={[styles.saveBtn, { backgroundColor: colors.primary, opacity: busy ? 0.6 : 1 }]}
                  >
                    {busy ? (
                      <ActivityIndicator size="small" color={colors.primaryForeground} />
                    ) : (
                      <Text style={[styles.saveText, { color: colors.primaryForeground }]}>Save</Text>
                    )}
                  </TouchableOpacity>
                </View>
                {target.average3 > 0 ? (
                  <TouchableOpacity accessibilityRole="button" onPress={() => setText(String(Math.round(target.average3)))} style={styles.link}>
                    <Text style={[styles.linkText, { color: colors.primary }]}>
                      Use the 3-month average ({formatCurrency(Math.round(target.average3), currency, { decimals: 0 })})
                    </Text>
                  </TouchableOpacity>
                ) : null}
                {target.budgeted != null ? (
                  <TouchableOpacity
                    accessibilityRole="button"
                    onPress={() => void write(() => endpoints.setBudgetLine(target.key, month, null), true)}
                    style={styles.link}
                  >
                    <Text style={[styles.linkText, { color: colors.destructive }]}>Clear this month's budget</Text>
                  </TouchableOpacity>
                ) : null}
              </>
            ) : (
              <Text style={[styles.note, { color: colors.mutedForeground }]}>
                Its spending counts in its group's budget.
              </Text>
            )}

            {error ? <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text> : null}

            {canBudget && onOpenRules ? (
              <View style={[styles.block, { borderTopColor: colors.border }]}>
                <TouchableOpacity accessibilityRole="button" onPress={() => onOpenRules(target.key, target.name)} style={styles.link}>
                  <Text style={[styles.linkText, { color: colors.primary }]}>
                    {plan?.ruleCount ? `Budget rules (${plan.ruleCount})` : "Add a budget rule for later months"}
                  </Text>
                </TouchableOpacity>
                {rulesMake && target.budgeted != null ? (
                  <TouchableOpacity
                    accessibilityRole="button"
                    onPress={() => void write(() => endpoints.setBudgetLine(target.key, month, null), true)}
                    style={styles.link}
                  >
                    <Text style={[styles.linkText, { color: colors.destructive }]}>Clear what is typed this month</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            ) : null}

            {canRoll ? (
              <View style={[styles.block, { borderTopColor: colors.border }]}>
                <View style={styles.switchRow}>
                  <Text style={[styles.switchLabel, { color: colors.foreground }]}>Roll leftover into next month</Text>
                  <Switch
                    accessibilityLabel="Roll leftover into next month"
                    value={target.rollover}
                    disabled={busy}
                    onValueChange={(rollover) => settings({ rollover })}
                  />
                </View>
                {target.rollover ? (
                  <>
                    <View style={styles.switchRow}>
                      <Text style={[styles.switchLabel, { color: colors.foreground }]}>Carry overspending too</Text>
                      <Switch
                        accessibilityLabel="Carry overspending too"
                        value={target.rolloverNegative === "carry"}
                        disabled={busy}
                        onValueChange={(on) => settings({ rolloverNegative: on ? "carry" : "reset" })}
                      />
                    </View>
                    <TouchableOpacity
                      accessibilityRole="button"
                      onPress={() => void write(() => endpoints.setBudgetCarryover(target.key, month, 0), false)}
                      style={styles.link}
                    >
                      <Text style={[styles.linkText, { color: colors.primary }]}>Reset carryover to 0 from this month</Text>
                    </TouchableOpacity>
                  </>
                ) : null}
              </View>
            ) : null}

            {target.categoryId != null ? (
              <View style={[styles.block, { borderTopColor: colors.border }]}>
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={() => onSeeSpending(target.categoryId as number, target.name)}
                  style={styles.link}
                >
                  <Text style={[styles.linkText, { color: colors.primary }]}>
                    {income ? "See this category's income" : "See this category's spending"}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={() => settings({ excluded: true }, true)}
                  style={styles.link}
                >
                  <Text style={[styles.linkText, { color: colors.mutedForeground }]}>Leave out of the budget</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-start" },
  sheet: {
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingBottom: 14,
    maxHeight: "85%",
  },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { flex: 1, fontSize: 17, fontWeight: "700", marginRight: 12 },
  facts: { fontSize: 13, marginTop: 2, fontVariant: ["tabular-nums"] },
  body: { marginTop: 10 },
  fieldLabel: { fontSize: 11, fontWeight: "700", letterSpacing: 0.5, marginBottom: 6 },
  inputRow: { flexDirection: "row", alignItems: "center" },
  input: {
    flex: 1,
    fontSize: 16,
    fontWeight: "600",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginRight: 8,
  },
  saveBtn: { paddingHorizontal: 18, paddingVertical: 11, borderRadius: 8, minWidth: 70, alignItems: "center" },
  saveText: { fontSize: 15, fontWeight: "700" },
  saveWide: { marginTop: 10, alignSelf: "stretch" },
  inputFull: { marginRight: 0, marginBottom: 6 },
  ruleRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", paddingVertical: 6 },
  ruleLabel: { fontSize: 14 },
  ruleValue: { fontSize: 15, fontWeight: "600", fontVariant: ["tabular-nums"] },
  totalRow: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: 4 },
  link: { paddingVertical: 9 },
  linkText: { fontSize: 14, fontWeight: "600" },
  note: { fontSize: 13, lineHeight: 18 },
  error: { fontSize: 13, marginTop: 8 },
  block: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: 8, paddingTop: 4 },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 4 },
  switchLabel: { flex: 1, fontSize: 14, marginRight: 8 },
});
