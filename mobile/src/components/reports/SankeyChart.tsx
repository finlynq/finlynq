// Cash-flow Sankey (react-native-svg). Income sources (left, teal) flow to
// expense uses (right, palette) with a proportional bipartite flow set; a
// savings bar sits below when income exceeds expenses, and in a deficit period
// a muted "From savings" source funds the shortfall. Geometry is the pure
// layoutSankey() in lib/reports/sankey.ts; this is a thin SVG wrapper. The
// chart is rendered at a width wide enough for legible flows and wrapped in a
// horizontal ScrollView so a narrow phone can pan it. No hover tooltips (touch)
// — labels + the column headers carry the amounts.
import React from "react";
import { View, Text, StyleSheet, ScrollView, Dimensions } from "react-native";
import Svg, { Path, Rect, Text as SvgText } from "react-native-svg";
import { useTheme } from "../../theme";
import { formatCurrency } from "../../lib/format";
import {
  layoutSankey,
  sankeyDesiredWidth,
  truncateLabel,
  type SankeyDatum,
} from "../../lib/reports/sankey";

const NODE_WIDTH = 16;
const LABEL_GAP = 6;
const MAX_LABEL_WIDTH = 92;
const FONT = 10.5;

export function SankeyChart({
  incomeData,
  expenseData,
  currency = "USD",
}: {
  incomeData: SankeyDatum[];
  expenseData: SankeyDatum[];
  currency?: string;
}) {
  const { colors } = useTheme();
  // Expense palette — deliberately starts away from teal so expenses don't read
  // as income; income nodes are always teal (colors.pos).
  const palette = [colors.chart4, colors.chart5, colors.chart1, colors.chart3, colors.chart2];

  const layoutOpts = {
    nodeWidth: NODE_WIDTH,
    labelGap: LABEL_GAP,
    maxLabelWidth: MAX_LABEL_WIDTH,
    paletteSize: palette.length,
  };
  const screenW = Math.max(260, Dimensions.get("window").width - 32);
  const width = Math.max(screenW, sankeyDesiredWidth(layoutOpts));
  const layout = layoutSankey(incomeData, expenseData, { ...layoutOpts, width });

  if (layout.empty) {
    return (
      <Text style={[styles.empty, { color: colors.mutedForeground }]}>
        No cash flow for the selected period.
      </Text>
    );
  }

  const maxChars = Math.max(4, Math.floor(MAX_LABEL_WIDTH / 6));

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator>
      <Svg width={layout.width} height={layout.height}>
        {/* Flows */}
        {layout.flows.map((f, i) => (
          <Path key={`f-${i}`} d={f.d} fill={palette[f.colorIndex]} opacity={0.28} />
        ))}

        {/* Income nodes (left) */}
        {layout.incomeNodes.map((n, i) => (
          <React.Fragment key={`in-${i}`}>
            <Rect
              x={n.x}
              y={n.y}
              width={n.w}
              height={Math.max(n.h, 2)}
              rx={3}
              fill={n.fromSavings ? colors.mutedForeground : colors.pos}
            />
            <SvgText
              x={n.x - LABEL_GAP}
              y={n.y + n.h / 2 + FONT / 3}
              fontSize={FONT}
              fill={n.fromSavings ? colors.mutedForeground : colors.foreground}
              textAnchor="end"
            >
              {truncateLabel(n.name, maxChars)}
            </SvgText>
          </React.Fragment>
        ))}

        {/* Expense nodes (right) */}
        {layout.expenseNodes.map((n, i) => (
          <React.Fragment key={`ex-${i}`}>
            <Rect x={n.x} y={n.y} width={n.w} height={Math.max(n.h, 2)} rx={3} fill={palette[n.colorIndex]} />
            <SvgText
              x={n.x + n.w + LABEL_GAP}
              y={n.y + n.h / 2 + FONT / 3}
              fontSize={FONT}
              fill={colors.foreground}
              textAnchor="start"
            >
              {truncateLabel(n.name, maxChars)}
            </SvgText>
          </React.Fragment>
        ))}

        {/* Column headers */}
        <SvgText
          x={layout.incomeHeaderX}
          y={layout.headerY}
          fontSize={FONT + 0.5}
          fill={colors.mutedForeground}
          textAnchor="middle"
          fontWeight="600"
        >
          {`Income (${formatCurrency(layout.totalIncome, currency, { decimals: 0 })})`}
        </SvgText>
        <SvgText
          x={layout.expenseHeaderX}
          y={layout.headerY}
          fontSize={FONT + 0.5}
          fill={colors.mutedForeground}
          textAnchor="middle"
          fontWeight="600"
        >
          {`Expenses (${formatCurrency(layout.totalExpenses, currency, { decimals: 0 })})`}
        </SvgText>

        {/* Savings bar */}
        {layout.savingsBar && (
          <>
            <Rect
              x={layout.savingsBar.x}
              y={layout.savingsBar.y}
              width={Math.max(layout.savingsBar.w, 2)}
              height={layout.savingsBar.h}
              rx={4}
              fill={colors.pos}
              opacity={0.8}
            />
            <SvgText
              x={layout.savingsBar.x + 8}
              y={layout.savingsBar.y + layout.savingsBar.h / 2 + FONT / 3}
              fontSize={FONT}
              fill={colors.foreground}
              textAnchor="start"
              fontWeight="600"
            >
              {`Savings: ${formatCurrency(layout.savings, currency, { decimals: 0 })} (${(
                (layout.savings / layout.totalIncome) *
                100
              ).toFixed(0)}%)`}
            </SvgText>
          </>
        )}
      </Svg>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  empty: { fontSize: 13, textAlign: "center", paddingVertical: 32 },
});
