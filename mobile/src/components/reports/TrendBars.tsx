// Per-period grouped income/expense bars (react-native-svg). Each period gets a
// teal income bar + a coral expense bar scaled to the combined max. Horizontally
// scrollable so daily/weekly granularities with many periods stay legible
// (bars keep a fixed min width and the chart grows past the screen).
//
// The SVG and the label row live inside ONE horizontally scrolled View so the
// labels move with their bars (they used to sit in a second, non-scrolling
// ScrollView and drifted off their bars on the first swipe). Labels are thinned
// to every `labelStep`-th period, and each shown label gets the width of the
// `labelStep` groups it covers, so "Jan 2026" isn't truncated to a 30px cell.
import React from "react";
import { View, Text, StyleSheet, ScrollView, Dimensions } from "react-native";
import Svg, { Rect, Line } from "react-native-svg";
import { useTheme } from "../../theme";
import type { TrendsPoint } from "../../../../shared/types";

const HEIGHT = 132;
const PAD_TOP = 8;
const GROUP_GAP = 10;
const BAR_W = 9;
const BAR_GAP = 2;
const GROUP_W = BAR_W * 2 + BAR_GAP + GROUP_GAP;
const LABEL_H = 16;
/** Roughly how many labels should be readable across the visible width. */
const TARGET_VISIBLE_LABELS = 5;
/** Narrowest cell that still fits a "Jan 2026" / "2026-W40" label at 9pt. */
const MIN_LABEL_W = 48;

/**
 * Show every `labelStep`-th label. Derived from how many groups are VISIBLE
 * (not the total count — the chart scrolls, so a 365-day range must not thin
 * its labels to one per 46 days), and never narrower than MIN_LABEL_W.
 */
export function trendLabelStep(pointCount: number, viewportW: number, groupW = GROUP_W): number {
  if (pointCount <= 0) return 1;
  const visible = Math.max(1, Math.min(pointCount, Math.floor(viewportW / groupW)));
  const byVisible = Math.ceil(visible / TARGET_VISIBLE_LABELS);
  const byWidth = Math.ceil(MIN_LABEL_W / groupW);
  return Math.max(1, byVisible, byWidth);
}

export function TrendBars({ points }: { points: TrendsPoint[] }) {
  const { colors } = useTheme();
  const screenW = Math.max(240, Dimensions.get("window").width - 64);

  if (points.length === 0) {
    return (
      <Text style={[styles.empty, { color: colors.mutedForeground }]}>No periods in this range.</Text>
    );
  }

  const contentW = Math.max(screenW, points.length * GROUP_W + GROUP_GAP);
  const baseY = HEIGHT - 2; // bars sit on the bottom edge; labels are a row below
  const usableH = baseY - PAD_TOP;

  const maxVal = Math.max(1, ...points.map((p) => Math.max(p.income, p.expenses)));

  const labelStep = trendLabelStep(points.length, screenW);
  const labelW = GROUP_W * labelStep;

  return (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ width: contentW }}>
          <Svg width={contentW} height={HEIGHT}>
            <Line x1={0} y1={baseY} x2={contentW} y2={baseY} stroke={colors.border} strokeWidth={1} />
            {points.map((p, i) => {
              const gx = GROUP_GAP + i * GROUP_W;
              const incH = (Math.max(0, p.income) / maxVal) * usableH;
              const expH = (Math.max(0, p.expenses) / maxVal) * usableH;
              return (
                <React.Fragment key={p.period}>
                  <Rect x={gx} y={baseY - incH} width={BAR_W} height={Math.max(incH, 1)} rx={2} fill={colors.pos} />
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
          {/* Same scrolled View as the SVG → labels stay under their bars. */}
          <View style={[styles.labelRow, { width: contentW }]}>
            {points.map((p, i) => {
              if (i % labelStep !== 0) return null;
              const left = GROUP_GAP + i * GROUP_W;
              return (
                <Text
                  key={p.period}
                  style={[
                    styles.label,
                    { color: colors.mutedForeground, left, width: Math.min(labelW, contentW - left) },
                  ]}
                  numberOfLines={1}
                >
                  {p.label}
                </Text>
              );
            })}
          </View>
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
  labelRow: { height: LABEL_H, marginTop: 4, position: "relative" },
  label: { position: "absolute", top: 0, fontSize: 9, textAlign: "left" },
  legend: { flexDirection: "row", gap: 16, marginTop: 10, justifyContent: "center" },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  legendDot: { width: 10, height: 10, borderRadius: 3 },
  legendText: { fontSize: 12 },
});
