export const CHART_COLORS = {
  // 12 category colors that work in light and dark mode (FINLYNQ-192).
  // Hue-ordered so ADJACENT entries differ as much as possible — in particular
  // the two purple-family colors (indigo idx0, violet idx6) are kept far apart
  // so a stacked "By account" view with ~10 bands no longer blends to mostly
  // purple. The palette is also wider than 10, so a 10-band stack uses 10
  // distinct hues before any cycling. The stacked-band fill / legend / tooltip
  // dots all read from this single source (chart-stack.ts → bandColor).
  categories: [
    "#6366f1", // indigo
    "#f59e0b", // amber
    "#10b981", // emerald
    "#f43f5e", // rose
    "#06b6d4", // cyan
    "#f97316", // orange
    "#8b5cf6", // violet
    "#84cc16", // lime
    "#ec4899", // pink
    "#14b8a6", // teal
    "#eab308", // yellow
    "#64748b", // slate
  ],
  positive: "#10b981", // green for income/growth
  negative: "#f43f5e", // red for expenses/loss
  neutral: "#6366f1", // indigo for neutral
} as const;
