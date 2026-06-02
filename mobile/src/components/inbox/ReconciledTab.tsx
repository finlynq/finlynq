// ReconciledTab — read-only list of bank rows already linked to a transaction.
// Mirrors web src/components/inbox/inbox-reconciled-tab.tsx. The Auto-pilot lens
// also renders the "X rows auto-applied by rules" banner on top.

import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { useTheme } from "../../theme";
import { Icon } from "../icon";
import { AutoRuleBanner } from "./AutoRuleBanner";
import { reconciledRows } from "../../lib/inbox";
import { formatCurrency, formatShortDate, safeName } from "../../lib/format";
import type { ReconcileSuggestions } from "../../../../shared/types";

export function ReconciledTab({
  snapshot,
  accountId,
  showAutoRuleBanner = false,
}: {
  snapshot: ReconcileSuggestions | null;
  accountId: number;
  showAutoRuleBanner?: boolean;
}) {
  const { colors } = useTheme();
  const rows = reconciledRows(snapshot);

  return (
    <View>
      {showAutoRuleBanner && <AutoRuleBanner accountId={accountId} />}

      {rows.length === 0 ? (
        <View style={[styles.empty, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Icon name="inbox" size={32} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
            Nothing reconciled yet
          </Text>
          <Text style={[styles.emptySub, { color: colors.mutedForeground }]}>
            Once you approve or categorize a row, it shows up here — in your bank ledger AND your
            transaction history.
          </Text>
        </View>
      ) : (
        <>
          <Text style={[styles.count, { color: colors.mutedForeground }]}>
            {rows.length} reconciled link{rows.length === 1 ? "" : "s"}.
          </Text>
          {rows.map(({ link, bank, tx }) => {
            const amountColor = bank.amount < 0 ? colors.neg : colors.pos;
            return (
              <View
                key={`${link.transactionId}:${link.bankTransactionId}`}
                style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border }]}
              >
                <Text style={[styles.date, { color: colors.mutedForeground }]}>
                  {formatShortDate(bank.date)}
                </Text>
                <View style={styles.body}>
                  <Text style={[styles.payee, { color: colors.foreground }]} numberOfLines={1}>
                    {safeName(bank.payee ?? tx.payee, "(no payee)")}
                  </Text>
                  {tx.categoryName ? (
                    <Text style={[styles.category, { color: colors.mutedForeground }]} numberOfLines={1}>
                      {tx.categoryName}
                      {link.linkType === "extra" ? " · extra" : ""}
                    </Text>
                  ) : link.linkType === "extra" ? (
                    <Text style={[styles.category, { color: colors.mutedForeground }]}>extra</Text>
                  ) : null}
                </View>
                <View style={styles.right}>
                  <Icon name="check" size={13} color={colors.pos} />
                  <Text style={[styles.amount, { color: amountColor }]}>
                    {formatCurrency(bank.amount, bank.currency || "CAD")}
                  </Text>
                </View>
              </View>
            );
          })}
        </>
      )}
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
  emptyTitle: { fontSize: 15, fontWeight: "700", marginTop: 4 },
  emptySub: { fontSize: 12, textAlign: "center", lineHeight: 18 },
  count: { fontSize: 12, marginBottom: 8 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 6,
  },
  date: { fontSize: 11, fontVariant: ["tabular-nums"] },
  body: { flex: 1 },
  payee: { fontSize: 14, fontWeight: "500" },
  category: { fontSize: 11, marginTop: 2 },
  right: { flexDirection: "row", alignItems: "center", gap: 5 },
  amount: { fontSize: 14, fontWeight: "600", fontVariant: ["tabular-nums"] },
});
