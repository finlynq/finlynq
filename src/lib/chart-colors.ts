export const CHART_COLORS = {
  // 8 category colors that work in light and dark mode
  categories: [
    "#6366f1", // indigo
    "#8b5cf6", // violet
    "#f59e0b", // amber
    "#10b981", // emerald
    "#06b6d4", // cyan
    "#f43f5e", // rose
    "#f97316", // orange
    "#64748b", // slate
  ],
  positive: "#10b981", // green for income/growth
  negative: "#f43f5e", // red for expenses/loss
  neutral: "#6366f1", // indigo for neutral
} as const;
