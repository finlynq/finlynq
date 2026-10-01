// SVG line chart: market value (solid amber) vs cost basis (dashed muted),
// scaled to the combined visible min/max. Pure react-native-svg + chart.ts
// geometry. The period selector lives on the screen, not here.
import React from "react";
import { View, Text, StyleSheet, Dimensions } from "react-native";
import Svg, { Line, Polyline } from "react-native-svg";
import { useTheme } from "../../theme";
import { scalePoints, seriesRange } from "../../lib/portfolio/chart";
import { formatShortDate } from "../../lib/format";
import type { PerformancePoint } from "../../../../shared/types";

const HEIGHT = 130;

export const PERFORMANCE_EMPTY_TEXT =
  "Not enough history yet. Portfolio snapshots are built when the Net Worth chart is opened on the web (or by a balance-history rebuild), not nightly. Pull down to refresh afterwards.";

export function PerformanceChart({
  series,
  width,
}: {
  series: PerformancePoint[];
  width?: number;
}) {
  const { colors } = useTheme();
  // Default width = screen minus the screen's 16px padding + card's 16px padding
  // on each side (≈ 64). Falls back gracefully if Dimensions is stubbed.
  const w = width ?? Math.max(200, Dimensions.get("window").width - 64);

  if (series.length < 2) {
    // Snapshots are NOT built by a nightly job: the server builds them when
    // the Net Worth chart loads (self-heal) or on a manual history rebuild.
    return (
      <Text style={[styles.empty, { color: colors.mutedForeground }]}>
        {PERFORMANCE_EMPTY_TEXT}
      </Text>
    );
  }

  const mv = series.map((p) => p.marketValue);
  const cb = series.map((p) => p.costBasis);
  const { min, max } = seriesRange([mv, cb]);
  const mvPoints = scalePoints(mv, min, max, w, HEIGHT);
  const cbPoints = scalePoints(cb, min, max, w, HEIGHT);

  return (
    <View>
      <Svg width={w} height={HEIGHT} viewBox={`0 0 ${w} ${HEIGHT}`}>
        <Line x1={0} y1={HEIGHT * 0.25} x2={w} y2={HEIGHT * 0.25} stroke={colors.border} strokeWidth={1} />
        <Line x1={0} y1={HEIGHT * 0.62} x2={w} y2={HEIGHT * 0.62} stroke={colors.border} strokeWidth={1} />
        <Polyline
          points={cbPoints}
          fill="none"
          stroke={colors.mutedForeground}
          strokeWidth={1.5}
          strokeDasharray="3,3"
        />
        <Polyline points={mvPoints} fill="none" stroke={colors.chart1} strokeWidth={2.5} />
      </Svg>
      <View style={styles.legendRow}>
        <Text style={[styles.legendDate, { color: colors.mutedForeground }]}>
          {formatShortDate(series[0].date)}
        </Text>
        <Text style={[styles.legendKey, { color: colors.mutedForeground }]}>
          — value · ···· cost
        </Text>
        <Text style={[styles.legendDate, { color: colors.mutedForeground }]}>
          {formatShortDate(series[series.length - 1].date)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  legendRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 8,
  },
  legendDate: { fontSize: 11, fontVariant: ["tabular-nums"] },
  legendKey: { fontSize: 11 },
  empty: { fontSize: 13, textAlign: "center", paddingVertical: 24 },
});
