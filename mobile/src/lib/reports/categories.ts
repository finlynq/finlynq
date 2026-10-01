// Helpers for the Category reports screens (overview + single category).
// The math lives on the server (web lib/reports/category-{overview,detail}.ts);
// these only format what it returns.

/** 12 hue-ordered category colors — mirrors web `CHART_COLORS.categories`. */
export const CATEGORY_PALETTE = [
  "#6366f1", "#f59e0b", "#10b981", "#f43f5e", "#06b6d4", "#f97316",
  "#8b5cf6", "#84cc16", "#ec4899", "#14b8a6", "#eab308", "#64748b",
] as const;

/** Slate — the "Other" bucket. */
export const OTHER_COLOR = CATEGORY_PALETTE[11];

export const CATEGORY_WINDOWS = [6, 12, 24] as const;

/** `YYYY-MM` shifted by `delta` months. */
export function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

/** The device's current month, `YYYY-MM`. */
export function currentMonthKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** "October 2026" / "Oct 26". */
export function monthLabel(key: string, style: "long" | "short" = "long"): string {
  const parts = key.split("-").map(Number);
  if (parts.length < 2 || !parts[0] || !parts[1]) return key;
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const name = names[parts[1] - 1] ?? "";
  return style === "long" ? `${name} ${parts[0]}` : `${name.slice(0, 3)} ${String(parts[0]).slice(2)}`;
}

/** "+12%" / "-8%"; null when there's no baseline. */
export function changeLabel(change: number | null | undefined): string | null {
  if (change == null || !Number.isFinite(change)) return null;
  const pct = Math.round(change * 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}

/**
 * Whether a change is good news: spending going down, or income going up.
 * null when there's nothing to judge.
 */
export function changeIsGood(change: number | null | undefined, isIncome: boolean): boolean | null {
  if (change == null || !Number.isFinite(change) || change === 0) return null;
  return change > 0 === isIncome;
}

/** "22%" (one decimal under 10%). */
export function sharePct(share: number | null | undefined): string {
  if (share == null || !Number.isFinite(share)) return "—";
  const p = share * 100;
  return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}
