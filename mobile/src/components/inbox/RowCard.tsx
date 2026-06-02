// RowCard — single bank-row card for the Approve-each / Auto-pilot lenses.
// Pure presentation: every action bubbles to the parent (which owns the fetch
// lifecycle + busy state). Mirrors the web RowCard (src/components/inbox/
// row-card.tsx) adapted to React Native primitives.

import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useTheme } from "../../theme";
import { Icon } from "../icon";
import { formatCurrency, formatShortDate } from "../../lib/format";
import type { CardSuggestion } from "../../lib/inbox";

export interface RowCardBank {
  id: string;
  date: string;
  amount: number;
  currency: string;
  payee: string | null;
}

function SuggestionLine({ suggestion }: { suggestion: CardSuggestion | null }) {
  const { colors } = useTheme();
  if (suggestion == null) {
    return (
      <Text style={[styles.sugMuted, { color: colors.mutedForeground }]}>
        No match — choose a category
      </Text>
    );
  }
  if (suggestion.kind === "match") {
    return (
      <View style={styles.sugRow}>
        <Icon name="link" size={13} color={colors.chart4} />
        <Text style={[styles.sugText, { color: colors.mutedForeground }]} numberOfLines={1}>
          match tx #{suggestion.transactionId}
          {suggestion.txPayee ? ` · ${suggestion.txPayee}` : ""}
          {suggestion.txCategoryName ? ` · ${suggestion.txCategoryName}` : ""}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.sugRow}>
      <Icon name="sampleData" size={13} color={colors.pos} />
      <Text style={[styles.sugText, { color: colors.mutedForeground }]} numberOfLines={1}>
        create as <Text style={{ fontWeight: "700" }}>{suggestion.categoryName}</Text>
      </Text>
    </View>
  );
}

export function RowCard({
  bank,
  suggestion,
  busy,
  onPrimary,
  onChooseCategory,
  onDelete,
}: {
  bank: RowCardBank;
  suggestion: CardSuggestion | null;
  busy: boolean;
  /** One-tap commit with the suggested category (parent falls back to the
   *  picker when the suggestion can't resolve a categoryId). */
  onPrimary: () => void;
  /** Open the category picker to choose / override the category. */
  onChooseCategory: () => void;
  onDelete: () => void;
}) {
  const { colors } = useTheme();
  const hasSuggestion = suggestion != null;
  const amountColor =
    bank.amount < 0 ? colors.neg : bank.amount > 0 ? colors.pos : colors.foreground;

  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.topRow}>
        <Text style={[styles.date, { color: colors.mutedForeground }]}>
          {formatShortDate(bank.date)}
        </Text>
        <Text style={[styles.payee, { color: colors.foreground }]} numberOfLines={1}>
          {bank.payee ?? "(no payee)"}
        </Text>
        <Text style={[styles.amount, { color: amountColor }]}>
          {formatCurrency(bank.amount, bank.currency || "CAD")}
        </Text>
      </View>

      <View style={styles.sugWrap}>
        <SuggestionLine suggestion={suggestion} />
      </View>

      <View style={styles.actions}>
        <TouchableOpacity
          style={[
            styles.primaryBtn,
            { backgroundColor: hasSuggestion ? colors.primary : colors.secondary },
            busy && styles.disabled,
          ]}
          onPress={hasSuggestion ? onPrimary : onChooseCategory}
          disabled={busy}
        >
          <Icon
            name={hasSuggestion ? "check" : "add"}
            size={15}
            color={hasSuggestion ? colors.primaryForeground : colors.foreground}
          />
          <Text
            style={[
              styles.primaryText,
              { color: hasSuggestion ? colors.primaryForeground : colors.foreground },
            ]}
          >
            {hasSuggestion ? "Approve" : "Categorize"}
          </Text>
        </TouchableOpacity>

        {hasSuggestion && (
          <TouchableOpacity
            style={[styles.iconBtn, { borderColor: colors.border }, busy && styles.disabled]}
            onPress={onChooseCategory}
            disabled={busy}
            accessibilityLabel="Choose a different category"
          >
            <Icon name="edit" size={15} color={colors.mutedForeground} />
          </TouchableOpacity>
        )}

        <TouchableOpacity
          style={[styles.iconBtn, { borderColor: colors.border }, busy && styles.disabled]}
          onPress={onDelete}
          disabled={busy}
          accessibilityLabel="Delete bank row"
        >
          <Icon name="trash" size={15} color={colors.mutedForeground} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    marginBottom: 8,
  },
  topRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  date: { fontSize: 12, fontVariant: ["tabular-nums"] },
  payee: { flex: 1, fontSize: 14, fontWeight: "600" },
  amount: { fontSize: 14, fontWeight: "700", fontVariant: ["tabular-nums"] },
  sugWrap: { marginTop: 6, marginBottom: 10 },
  sugRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  sugText: { flex: 1, fontSize: 12 },
  sugMuted: { fontSize: 12, fontStyle: "italic" },
  actions: { flexDirection: "row", alignItems: "center", gap: 8 },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  primaryText: { fontSize: 13, fontWeight: "700" },
  iconBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  disabled: { opacity: 0.5 },
});
