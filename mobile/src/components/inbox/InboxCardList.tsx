// InboxCardList — the To-approve (Approve-each) / To-categorize (Auto-pilot)
// card body. One parameterized component covers both lenses (web ships two
// near-identical InboxToApproveTab / InboxToCategorizeTab files; the only real
// difference is the commit endpoint, which the parent picks by lens). Pure
// presentation — the parent owns the snapshot fetch, the category picker, and
// the commit/delete handlers.

import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useTheme } from "../../theme";
import { Icon } from "../icon";
import { RowCard } from "./RowCard";
import type { CardSuggestion } from "../../lib/inbox";
import type { AccountMode, ReconcileBankSnapshot } from "../../../../shared/types";

export function InboxCardList({
  lens,
  rows,
  suggestionByBank,
  busyBankId,
  bulkBusy,
  suggestedCount,
  onPrimary,
  onChooseCategory,
  onDelete,
  onApproveAll,
}: {
  /** 'approve' or 'auto' — only used for the empty-state + bulk-action copy. */
  lens: AccountMode;
  rows: ReconcileBankSnapshot[];
  suggestionByBank: Map<string, CardSuggestion>;
  busyBankId: string | null;
  bulkBusy: boolean;
  suggestedCount: number;
  onPrimary: (bankId: string) => void;
  onChooseCategory: (bankId: string) => void;
  onDelete: (bankId: string) => void;
  /** Approve-each only — bulk-approve every suggested row. */
  onApproveAll?: () => void;
}) {
  const { colors } = useTheme();

  if (rows.length === 0) {
    return (
      <View style={[styles.empty, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Icon name="inbox" size={32} color={colors.mutedForeground} />
        <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
          {lens === "auto" ? "Auto-pilot is handling everything" : "Nothing waiting for approval"}
        </Text>
        <Text style={[styles.emptySub, { color: colors.mutedForeground }]}>
          {lens === "auto"
            ? "Either every row was auto-categorized by a rule, or nothing new has come in. Upload a statement (on the web app) and rows with no rule match will appear here."
            : "Upload a statement to this account (on the web app) and rows will appear here with one-tap approve."}
        </Text>
      </View>
    );
  }

  return (
    <View>
      <View style={styles.headerRow}>
        <Text style={[styles.count, { color: colors.mutedForeground }]}>
          {rows.length} row{rows.length === 1 ? "" : "s"} waiting
          {suggestedCount > 0 ? ` · ${suggestedCount} with a suggestion` : ""}
        </Text>
        {lens === "approve" && suggestedCount > 0 && onApproveAll && (
          <TouchableOpacity
            style={[styles.bulkBtn, { backgroundColor: colors.primary }, bulkBusy && styles.disabled]}
            onPress={onApproveAll}
            disabled={bulkBusy}
          >
            <Icon name="check" size={14} color={colors.primaryForeground} />
            <Text style={[styles.bulkText, { color: colors.primaryForeground }]}>
              Approve all ({suggestedCount})
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {rows.map((b) => (
        <RowCard
          key={b.id}
          bank={{ id: b.id, date: b.date, amount: b.amount, currency: b.currency, payee: b.payee }}
          suggestion={suggestionByBank.get(b.id) ?? null}
          busy={busyBankId === b.id || bulkBusy}
          onPrimary={() => onPrimary(b.id)}
          onChooseCategory={() => onChooseCategory(b.id)}
          onDelete={() => onDelete(b.id)}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  empty: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 24,
    alignItems: "center",
    gap: 8,
  },
  emptyTitle: { fontSize: 15, fontWeight: "700", marginTop: 4, textAlign: "center" },
  emptySub: { fontSize: 12, textAlign: "center", lineHeight: 18 },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 8,
  },
  count: { flex: 1, fontSize: 12 },
  bulkBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
  },
  bulkText: { fontSize: 12, fontWeight: "700" },
  disabled: { opacity: 0.5 },
});
