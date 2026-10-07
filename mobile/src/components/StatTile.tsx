// Small summary tile (label / big value / optional sub-line) used in the
// two-column tile rows on the Subscriptions and Transactions screens. Half
// width (48.5%), so lay tiles out in a `flexDirection: "row", flexWrap: "wrap",
// justifyContent: "space-between"` container.
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { useTheme } from "../theme";

export function StatTile({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.tile, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.label, { color: colors.mutedForeground }]} numberOfLines={1}>{label}</Text>
      <Text style={[styles.value, { color: color ?? colors.foreground }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      {sub ? <Text style={[styles.sub, { color: colors.mutedForeground }]}>{sub}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    width: "48.5%",
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
  },
  label: { fontSize: 12, fontWeight: "600" },
  value: { fontSize: 19, fontWeight: "800", marginTop: 2, fontVariant: ["tabular-nums"] },
  sub: { fontSize: 11, marginTop: 1 },
});
