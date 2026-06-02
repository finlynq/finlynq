// AutoRuleBanner — surfaces recent rule-fired transactions on the Auto-pilot
// lens's Reconciled tab. Mirrors web src/components/inbox/auto-rule-banner.tsx.
// Self-fetches GET /api/reconcile/auto-rule-recent and renders the count + a
// preview list so the upload-time rule firing stays auditable.

import React, { useEffect, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useTheme } from "../../theme";
import { Icon } from "../icon";
import { endpoints } from "../../api/client";
import { logger } from "../../lib/logger";
import { formatCurrency, formatShortDate, safeName } from "../../lib/format";
import type { AutoRuleRecent } from "../../../../shared/types";

const PREVIEW_LIMIT = 5;

export function AutoRuleBanner({ accountId }: { accountId: number }) {
  const { colors } = useTheme();
  const [data, setData] = useState<AutoRuleRecent | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    endpoints
      .getAutoRuleRecent(accountId)
      .then((res) => {
        if (cancelled) return;
        if (res.success) setData(res.data);
        else {
          logger.warn("inbox", "auto-rule-recent fetch failed", { error: res.error });
          setData(null);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        logger.warn("inbox", "auto-rule-recent threw", { detail });
        setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  if (loading || !data || data.count === 0) return null;

  const preview = expanded ? data.items : data.items.slice(0, PREVIEW_LIMIT);
  const hasMore = data.items.length > PREVIEW_LIMIT;

  return (
    <View style={[styles.card, { borderColor: colors.pos, backgroundColor: colors.card }]}>
      <View style={styles.headerRow}>
        <Icon name="sampleData" size={15} color={colors.pos} />
        <Text style={[styles.headerText, { color: colors.foreground }]}>
          {data.count} row{data.count === 1 ? "" : "s"} auto-applied by rules in the last{" "}
          {data.windowDays} day{data.windowDays === 1 ? "" : "s"}
        </Text>
      </View>

      <View style={styles.list}>
        {preview.map((item) => {
          const amountColor = item.amount < 0 ? colors.neg : colors.pos;
          return (
            <View key={item.id} style={[styles.itemRow, { borderTopColor: colors.border }]}>
              <Text style={[styles.itemDate, { color: colors.mutedForeground }]}>
                {formatShortDate(item.date)}
              </Text>
              <Text style={[styles.itemPayee, { color: colors.foreground }]} numberOfLines={1}>
                {safeName(item.payee, "(no payee)")}
                {item.categoryName ? ` · ${item.categoryName}` : ""}
              </Text>
              <Text style={[styles.itemAmount, { color: amountColor }]}>
                {formatCurrency(item.amount, item.currency || "CAD")}
              </Text>
            </View>
          );
        })}
      </View>

      {hasMore && (
        <TouchableOpacity onPress={() => setExpanded((e) => !e)} style={styles.moreBtn}>
          <Text style={[styles.moreText, { color: colors.primary }]}>
            {expanded ? "Show fewer" : `Show ${data.items.length - PREVIEW_LIMIT} more`}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    marginBottom: 10,
  },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  headerText: { flex: 1, fontSize: 13, fontWeight: "600" },
  list: { marginTop: 8 },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 7,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  itemDate: { fontSize: 11, fontVariant: ["tabular-nums"] },
  itemPayee: { flex: 1, fontSize: 12 },
  itemAmount: { fontSize: 12, fontWeight: "600", fontVariant: ["tabular-nums"] },
  moreBtn: { marginTop: 8, alignSelf: "flex-start" },
  moreText: { fontSize: 12, fontWeight: "600" },
});
