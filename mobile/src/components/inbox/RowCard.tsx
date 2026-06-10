// RowCard — single bank-row card for the Approve-each / Auto-pilot lenses.
// Pure presentation: every action bubbles to the parent (which owns the fetch
// lifecycle + busy state). Mirrors the web RowCard (src/components/inbox/
// row-card.tsx) adapted to React Native primitives.

import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useTheme } from "../../theme";
import { Icon } from "../icon";
import { formatCurrency, formatShortDate } from "../../lib/format";
import type { CardSuggestion, CardDuplicate } from "../../lib/inbox";

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
  if (suggestion.kind === "transfer") {
    return (
      <View style={styles.sugRow}>
        <Icon name="transfer" size={13} color={colors.chart4} />
        <Text style={[styles.sugText, { color: colors.mutedForeground }]} numberOfLines={1}>
          transfer to <Text style={{ fontWeight: "700" }}>{suggestion.destAccountName}</Text>
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

/** Amber warning line for a possible ledger duplicate (web parity). */
function DuplicateLine({
  duplicate,
  fallbackCurrency,
}: {
  duplicate: CardDuplicate;
  fallbackCurrency: string;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.sugRow}>
      <Icon name="alert" size={13} color={colors.chart1} />
      <Text style={[styles.dupText, { color: colors.chart1 }]} numberOfLines={2}>
        Possible duplicate of an existing transaction
        {duplicate.txPayee ? ` · ${duplicate.txPayee}` : ""} ·{" "}
        {formatShortDate(duplicate.txDate)} ·{" "}
        {formatCurrency(
          duplicate.txAmount,
          duplicate.txCurrency || fallbackCurrency || "CAD",
        )}
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
  duplicate,
  onLinkExisting,
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
  /** When set, this bank row looks like a duplicate of an existing ledger
   *  transaction — the card warns and surfaces "Link to existing". */
  duplicate?: CardDuplicate | null;
  /** Link this bank row to the matched existing transaction instead of
   *  creating a new one (resolves the possible duplicate). */
  onLinkExisting?: () => void;
}) {
  const { colors } = useTheme();
  const hasSuggestion = suggestion != null;
  const isDup = duplicate != null;
  const amountColor =
    bank.amount < 0 ? colors.neg : bank.amount > 0 ? colors.pos : colors.foreground;
  // "Keep separate" deliberately mints a new ledger entry: commit with the
  // suggestion when there is one, otherwise let the user pick a category.
  const keepSeparate = hasSuggestion ? onPrimary : onChooseCategory;

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.card, borderColor: isDup ? colors.chart1 : colors.border },
      ]}
    >
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
        {isDup ? (
          <DuplicateLine duplicate={duplicate} fallbackCurrency={bank.currency} />
        ) : (
          <SuggestionLine suggestion={suggestion} />
        )}
      </View>

      <View style={styles.actions}>
        {isDup ? (
          <>
            <TouchableOpacity
              style={[
                styles.primaryBtn,
                { backgroundColor: colors.primary },
                busy && styles.disabled,
              ]}
              onPress={onLinkExisting}
              disabled={busy}
            >
              <Icon name="link" size={15} color={colors.primaryForeground} />
              <Text style={[styles.primaryText, { color: colors.primaryForeground }]}>
                Link to existing
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.secondaryBtn,
                { borderColor: colors.border },
                busy && styles.disabled,
              ]}
              onPress={keepSeparate}
              disabled={busy}
              accessibilityLabel="Keep this as a separate transaction"
            >
              <Text style={[styles.secondaryText, { color: colors.foreground }]}>
                Keep separate
              </Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
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
          </>
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
  dupText: { flex: 1, fontSize: 12, lineHeight: 16 },
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
  secondaryBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  secondaryText: { fontSize: 13, fontWeight: "600" },
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
