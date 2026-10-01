// One "top mover" row — up/down chip + name/ticker + signed day-change $ (primary)
// + signed %change (secondary), both colored by sign (FINLYNQ-238).
//
// Renders the server's consolidated `Mover` (FINLYNQ-190: one row per ticker
// across accounts). `dayChangeDisplay` is already in the overview's display
// currency, so it's formatted with that — never re-derived from a per-account
// change × qty. Tone follows the SIGN of the $ move; `changePct` can be null
// (no prior-day value), in which case the % line is omitted.
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { useTheme } from "../../theme";
import { Icon } from "../icon";
import { safeName } from "../../lib/format";
import { holdingDescription } from "../../lib/portfolio/holdings";
import { signedMoney } from "../../lib/portfolio/format";
import type { Mover } from "../../../../shared/types";

export function GainerLoserRow({ mover, currency }: { mover: Mover; currency: string }) {
  const { colors } = useTheme();
  const dayChange = mover.dayChangeDisplay ?? 0;
  const up = dayChange >= 0;
  const tone = dayChange > 0 ? colors.pos : dayChange < 0 ? colors.neg : colors.mutedForeground;
  // FINLYNQ-242: description leads, ticker is the subtitle; fall back to the
  // ticker as the primary line when the name just echoes it.
  const desc = holdingDescription({ name: mover.name, symbol: mover.symbol });
  const ticker = safeName(mover.symbol || mover.name, "—");
  const pct = mover.changePct;
  return (
    <View style={[styles.row, { borderBottomColor: colors.border }]}>
      <View
        style={[
          styles.arrow,
          { backgroundColor: up ? colors.pos + "26" : colors.neg + "26" },
        ]}
      >
        <Icon name={up ? "inflow" : "outflow"} size={14} color={tone} />
      </View>
      <View style={styles.mid}>
        <Text style={[styles.symbol, { color: colors.foreground }]} numberOfLines={1}>
          {desc ?? ticker}
        </Text>
        {desc != null && (
          <Text style={[styles.name, { color: colors.mutedForeground }]} numberOfLines={1}>
            {ticker}
          </Text>
        )}
      </View>
      <View style={styles.right}>
        <Text style={[styles.change, { color: tone }]}>
          {/* Cents for small moves so a real $0.42 move never reads "+$0". */}
          {signedMoney(dayChange, currency, Math.abs(dayChange) < 10 ? 2 : 0)}
        </Text>
        {pct != null && (
          <Text style={[styles.pct, { color: tone }]}>
            {pct >= 0 ? "+" : ""}
            {pct.toFixed(1)}%
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  arrow: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 10,
  },
  mid: { flex: 1, marginRight: 12 },
  symbol: { fontSize: 14, fontWeight: "600" },
  name: { fontSize: 12, marginTop: 1 },
  right: { alignItems: "flex-end" },
  change: { fontSize: 14, fontWeight: "700", fontVariant: ["tabular-nums"] },
  pct: { fontSize: 12, marginTop: 1, fontVariant: ["tabular-nums"] },
});
