// Per-period grouped income/expense bars (react-native-svg). Each period gets a
// teal income bar + a coral expense bar scaled to the combined max. Horizontally
// scrollable so daily/weekly granularities with many periods stay legible
// (bars keep a fixed min width and the chart grows past the screen). Labels are
// thinned so they never overlap.
import React from "react";
import { View, Text, StyleSheet, ScrollView, Dimensions } from "react-native";
import Svg, { Rect, Line } from "react-native-svg";
import { useTheme } from "../../theme";
import type { TrendsPoint } from "../../../../shared/types";

const HEIGHT = 150;
const PAD_TOP = 8;
const PAD_BOTTOM = 22;
const GROUP_GAP = 10;
const BAR_W = 9;
const BAR_GAP = 2;

export function TrendBars({ points }: { points: TrendsPoint[] }) {
  const { colors } = useTheme();
  const screenW = Math.max(240, Dimensions.get("window").width - 64);

  if (points.length === 0) {
    return (
      <Text style={[styles.empty, { color: colors.mutedForeground }]}>No periods in this range.</Text>
    );
  }

  const groupW = BAR_W * 2 + BAR_GAP + GROUP_GAP;
  const contentW = Math.max(screenW, points.length * groupW + GROUP_GAP);
  const usableH = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const baseY = HEIGHT - PAD_BOTTOM;

  const maxVal = Math.max(
    1,
    ...points.map((p) => Math.max(p.income, p.expenses))
  );

  // Thin labels so at most ~8 show across the visible width.
  const labelStep = Math.max(1, Math.ceil(points.length / 8));

  return (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Svg width={contentW} height={HEIGHT}>
          <Line x1={0} y1={baseY} x2={contentW} y2={baseY} stroke={colors.border} strokeWidth={1} />
          {points.map((p, i) => {
            const gx = GROUP_GAP + i * groupW;
            const incH = (p.income / maxVal) * usableH;
            const expH = (p.expenses / maxVal) * usableH;
            return (
              <React.Fragment key={p.period}>
                <Rect
                  x={gx}
                  y={baseY - incH}
                  width={BAR_W}
                  height={Math.max(incH, 1)}
                  rx={2}
                  fill={colors.pos}
                />
                <Rect
                  x={gx + BAR_W + BAR_GAP}
                  y={baseY - expH}
                  width={BAR_W}
                  height={Math.max(expH, 1)}
                  rx={2}
                  fill={colors.neg}
                />
              </React.Fragment>
            );
          })}
        </Svg>
        {/* Labels are an overlaid RN row so they wrap/clip with the SVG content. */}
      </ScrollView>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} scrollEnabled={false}>
        <View style={{ width: contentW, flexDirection: "row", paddingLeft: GROUP_GAP }}>
          {points.map((p, i) => (
            <Text
              key={p.period}
              style={[styles.label, { color: colors.mutedForeground, width: groupW }]}
              numberOfLines={1}
            >
              {i % labelStep === 0 ? p.label : ""}
            </Text>
          ))}
        </View>
      </ScrollView>
      <View style={styles.legend}>
        <Legend color={colors.pos} label="Income" />
        <Legend color={colors.neg} label="Expenses" />
      </View>
    </View>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={[styles.legendText, { color: colors.mutedForeground }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { fontSize: 13, textAlign: "center", paddingVertical: 24 },
  label: { fontSize: 9, textAlign: "left" },
  legend: { flexDirection: "row", gap: 16, marginTop: 10, justifyContent: "center" },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  legendDot: { width: 10, height: 10, borderRadius: 3 },
  legendText: { fontSize: 12 },
});
