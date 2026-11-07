// Fill budgets on the phone: the month's spending lines with no budget, from one
// of three sources, shown before anything is saved. Several months, an increase,
// other sources and overwriting stay on the web app's Fill dialog.
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { formatCurrency } from "../lib/format";
import { Icon } from "./icon";
import { formatMonthLabel, type BudgetFillRequest, type BudgetFillResult, type BudgetFillSource } from "../lib/budgets";

const SOURCES: Array<{ key: string; label: string; source: BudgetFillSource }> = [
  { key: "average", label: "3-month average spent", source: { kind: "average", months: 3 } },
  { key: "budget", label: "Last month's budget", source: { kind: "budget" } },
  { key: "spent", label: "Last month's spending", source: { kind: "spent" } },
];

export function BudgetFillSheet({
  visible,
  month,
  currency,
  onClose,
  onSaved,
}: {
  visible: boolean;
  month: string;
  currency: string;
  onClose: () => void;
  /** Reloads the month; called with how many budgets were written. */
  onSaved: (count: number) => Promise<void>;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [sourceKey, setSourceKey] = useState(SOURCES[0].key);
  const [preview, setPreview] = useState<BudgetFillResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setPreview(null);
      setError(null);
    }
  }, [visible, month]);

  if (!visible) return null;

  const request = (previewOnly: boolean): BudgetFillRequest => ({
    months: [month],
    source: (SOURCES.find((s) => s.key === sourceKey) ?? SOURCES[0]).source,
    overwrite: false,
    scope: { kind: "all" },
    section: "spending",
    preview: previewOnly,
  });

  const run = async (previewOnly: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await endpoints.fillBudgets(request(previewOnly));
      if (!res.success || !res.data) {
        setError((!res.success && res.error) || "Couldn't fill the budgets. Please try again.");
        return;
      }
      if (previewOnly) {
        setPreview(res.data);
        return;
      }
      await onSaved(res.data.rows.length);
      onClose();
    } catch {
      setError("Cannot connect to server");
    } finally {
      setBusy(false);
    }
  };

  const rows = preview?.rows ?? [];

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={[styles.sheet, { backgroundColor: colors.card, borderColor: colors.border, paddingTop: insets.top + 12 }]}
          onPress={() => {}}
        >
          <View style={styles.header}>
            <Text style={[styles.title, { color: colors.foreground }]}>Fill budgets</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityRole="button" accessibilityLabel="Close">
              <Icon name="close" size={20} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>
          <Text style={[styles.note, { color: colors.mutedForeground }]}>
            Spending lines with no budget for {formatMonthLabel(month)}. Budgets already set stay as they are.
          </Text>

          {SOURCES.map((s) => {
            const selected = s.key === sourceKey;
            return (
              <TouchableOpacity
                key={s.key}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                onPress={() => {
                  setSourceKey(s.key);
                  setPreview(null);
                }}
                style={styles.radioRow}
              >
                <View style={[styles.radio, { borderColor: selected ? colors.primary : colors.border }]}>
                  {selected ? <View style={[styles.radioDot, { backgroundColor: colors.primary }]} /> : null}
                </View>
                <Text style={[styles.radioLabel, { color: colors.foreground }]}>{s.label}</Text>
              </TouchableOpacity>
            );
          })}

          {preview ? (
            rows.length > 0 ? (
              <>
                <ScrollView style={[styles.preview, { borderColor: colors.border }]}>
                  {rows.map((r) => (
                    <View key={r.key} style={styles.previewRow}>
                      <Text style={[styles.previewName, { color: colors.foreground }]} numberOfLines={1}>
                        {r.name}
                      </Text>
                      <Text style={[styles.previewAmount, { color: colors.foreground }]}>
                        {formatCurrency(r.amount, currency)}
                      </Text>
                    </View>
                  ))}
                </ScrollView>
                <Text style={[styles.note, { color: colors.mutedForeground }]}>
                  {rows.length} {rows.length === 1 ? "budget" : "budgets"}, {formatCurrency(preview.total, currency)} in all.
                </Text>
              </>
            ) : (
              <Text style={[styles.note, { color: colors.mutedForeground }]}>
                Nothing to fill from this source: no line without a budget has an amount to use.
              </Text>
            )
          ) : null}

          {error ? <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text> : null}

          {preview && rows.length === 0 ? null : (
            <TouchableOpacity
              accessibilityRole="button"
              onPress={busy ? undefined : () => void run(!preview)}
              style={[styles.primaryBtn, { backgroundColor: colors.primary, opacity: busy ? 0.6 : 1 }]}
            >
              {busy ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : (
                <Text style={[styles.primaryText, { color: colors.primaryForeground }]}>
                  {preview ? `Save ${rows.length} ${rows.length === 1 ? "budget" : "budgets"}` : "Preview"}
                </Text>
              )}
            </TouchableOpacity>
          )}
          <Text style={[styles.note, { color: colors.mutedForeground }]}>
            Several months, an increase or replacing budgets: use the web app.
          </Text>
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
    maxHeight: "90%",
  },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { flex: 1, fontSize: 17, fontWeight: "700" },
  note: { fontSize: 12, lineHeight: 17, marginTop: 6 },
  radioRow: { flexDirection: "row", alignItems: "center", paddingVertical: 9 },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, alignItems: "center", justifyContent: "center", marginRight: 10 },
  radioDot: { width: 8, height: 8, borderRadius: 4 },
  radioLabel: { fontSize: 14 },
  preview: { maxHeight: 220, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, marginTop: 6 },
  previewRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 5 },
  previewName: { flex: 1, fontSize: 13, marginRight: 8 },
  previewAmount: { fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] },
  error: { fontSize: 13, marginTop: 8 },
  primaryBtn: { borderRadius: 10, paddingVertical: 12, alignItems: "center", marginTop: 10 },
  primaryText: { fontSize: 15, fontWeight: "700" },
});
