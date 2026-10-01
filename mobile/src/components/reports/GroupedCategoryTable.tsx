// Collapsible grouped category table. Rows are bucketed by their `group`
// (Other when empty); each group header shows the group total + a chevron, and
// expanding reveals the member categories with count + share-of-section. Used
// by the Income Statement + Trends screens. Names are decrypted server-side →
// always passed through safeName by the caller's mapping or here.
//
// `flat` renders the rows directly (sorted desc, no group headers) — for data
// whose rows already ARE groups (Trends "By group"), where bucketing would
// wrap each one in a redundant one-item collapsible.
import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { useTheme } from "../../theme";
import { formatCurrency, safeName } from "../../lib/format";
import { Icon } from "../icon";

export interface GroupedRow {
  name: string;
  group: string;
  total: number;
  count: number;
  /** When set (and `onPressItem` is passed), the row opens that category. */
  categoryId?: number | null;
}

interface Props {
  rows: GroupedRow[];
  currency: string;
  tone: "pos" | "neg";
  emptyText?: string;
  /** Makes category rows that carry a `categoryId` tappable. */
  onPressItem?: (row: GroupedRow) => void;
  /** Render rows as a flat list instead of collapsible group buckets. */
  flat?: boolean;
}

interface GroupBucket {
  name: string;
  items: GroupedRow[];
  total: number;
}

export function GroupedCategoryTable({ rows, currency, tone, emptyText, onPressItem, flat }: Props) {
  const { colors } = useTheme();
  const toneColor = tone === "pos" ? colors.pos : colors.neg;

  const { groups, sectionTotal } = useMemo(() => {
    const map = new Map<string, GroupBucket>();
    let total = 0;
    for (const r of rows) {
      const g = r.group && r.group.trim().length > 0 ? r.group : "Other";
      if (!map.has(g)) map.set(g, { name: g, items: [], total: 0 });
      const bucket = map.get(g)!;
      bucket.items.push(r);
      bucket.total += r.total;
      total += r.total;
    }
    const sorted = Array.from(map.values())
      .map((b) => ({ ...b, items: [...b.items].sort((a, z) => z.total - a.total) }))
      .sort((a, z) => z.total - a.total);
    return { groups: sorted, sectionTotal: total };
  }, [rows]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (g: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });

  if (rows.length === 0) {
    return (
      <Text style={[styles.empty, { color: colors.mutedForeground }]}>
        {emptyText ?? "No data for this range."}
      </Text>
    );
  }

  const renderItem = (item: GroupedRow, key: string, opts: { first?: boolean; indent: boolean }) => {
    const pct = sectionTotal > 0 ? (item.total / sectionTotal) * 100 : 0;
    const tappable = !!onPressItem && item.categoryId != null;
    return (
      <TouchableOpacity
        key={key}
        style={[
          styles.itemRow,
          { borderTopColor: colors.border, paddingLeft: opts.indent ? 36 : 12 },
          opts.first && { borderTopWidth: 0 },
        ]}
        disabled={!tappable}
        activeOpacity={0.7}
        onPress={() => onPressItem?.(item)}
        accessibilityRole={tappable ? "button" : undefined}
      >
        <View style={styles.itemTextWrap}>
          <Text style={[styles.itemName, { color: colors.foreground }]} numberOfLines={1}>
            {safeName(item.name)}
          </Text>
          <Text style={[styles.itemMeta, { color: colors.mutedForeground }]}>
            {item.count} txn{item.count === 1 ? "" : "s"} · {pct.toFixed(0)}%
          </Text>
        </View>
        <Text style={[styles.itemAmount, { color: opts.indent ? colors.foreground : toneColor }]}>
          {formatCurrency(item.total, currency, { decimals: 0 })}
        </Text>
        {tappable && <Icon name="chevronRight" size={14} color={colors.mutedForeground} />}
      </TouchableOpacity>
    );
  };

  const totalRow = (
    <View style={[styles.totalRow, { borderTopColor: colors.border }]}>
      <Text style={[styles.totalLabel, { color: colors.mutedForeground }]}>Total</Text>
      <Text style={[styles.totalValue, { color: toneColor }]}>
        {formatCurrency(sectionTotal, currency, { decimals: 0 })}
      </Text>
    </View>
  );

  if (flat) {
    const sorted = [...rows].sort((a, z) => z.total - a.total);
    return (
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        {sorted.map((item, i) => renderItem(item, `flat:${item.name}:${i}`, { first: i === 0, indent: false }))}
        {totalRow}
      </View>
    );
  }

  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      {groups.map((g, gi) => {
        const open = expanded.has(g.name);
        return (
          <View key={g.name}>
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={() => toggle(g.name)}
              style={[
                styles.groupRow,
                gi > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
              ]}
            >
              <Icon
                name={open ? "chevronDown" : "chevronRight"}
                size={16}
                color={colors.mutedForeground}
              />
              <Text style={[styles.groupName, { color: colors.foreground }]} numberOfLines={1}>
                {safeName(g.name)}
              </Text>
              <Text style={[styles.groupTotal, { color: toneColor }]}>
                {formatCurrency(g.total, currency, { decimals: 0 })}
              </Text>
            </TouchableOpacity>

            {open && g.items.map((item, ii) => renderItem(item, `${g.name}:${item.name}:${ii}`, { indent: true }))}
          </View>
        );
      })}

      {totalRow}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  groupRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 13, gap: 8 },
  groupName: { flex: 1, fontSize: 14, fontWeight: "700" },
  groupTotal: { fontSize: 14, fontWeight: "700", fontVariant: ["tabular-nums"] },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingRight: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  itemTextWrap: { flex: 1, marginRight: 10 },
  itemName: { fontSize: 14, fontWeight: "500" },
  itemMeta: { fontSize: 11, marginTop: 2 },
  itemAmount: { fontSize: 14, fontWeight: "600", fontVariant: ["tabular-nums"] },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 13,
    borderTopWidth: 1,
  },
  totalLabel: { fontSize: 13, fontWeight: "700", letterSpacing: 0.3 },
  totalValue: { fontSize: 15, fontWeight: "800", fontVariant: ["tabular-nums"] },
  empty: { fontSize: 14, textAlign: "center", paddingVertical: 24 },
});
