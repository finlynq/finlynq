/**
 * chart-stack.ts — shared pure util for the FINLYNQ-129 stacked-member toggle.
 *
 * Turns a set of value-over-time points, each carrying a per-member breakdown,
 * into the row shape Recharts `<Area stackId>` needs PLUS the legend describing
 * each coloured band. Builds ON the FINLYNQ-128 breakdown layer: callers pass
 * the same `BreakdownMember`-shaped members (id + display name + value) that the
 * tooltip uses; the names are already DEK-resolved at the API boundary.
 *
 * What it does (single source of truth for the stacking math):
 *   1. Rank members by AVERAGE absolute contribution across the WHOLE window
 *      (per the item spec — re-ranks when the caller passes a new window), then
 *      keep the top `maxMembers` distinct member keys.
 *   2. Emit one row per point: `{ [dateKey]: date, <key>: value, … , __other }`
 *      where each kept key gets that point's value (0 when absent) and `__other`
 *      is the SIGNED residual `total − Σ(kept)` so the outer stack boundary
 *      equals the aggregate `total` at EVERY point (tc-1 / tc-2 / tc-3 gate).
 *   3. Return a `legend` (key → display name → palette colour) — "Other" always
 *      takes the last/neutral slot.
 *
 * PURE / CLIENT-SAFE: zero deps beyond the shared palette + the BreakdownMember
 * type, no @/db, no next/server, no Date.now(). Safe from "use client".
 */

import type { BreakdownMember } from "@/lib/chart-breakdown";
import { CHART_COLORS } from "@/lib/chart-colors";

/** Stable key prefix for a member band data key (avoids collisions with "date"/"total"). */
export const STACK_KEY_PREFIX = "m_";
/** Reserved data key for the collapsed "Other" residual band. */
export const OTHER_STACK_KEY = "__other";

/** Recharts stackId for the above-axis (asset / positive-contribution) group. */
export const POSITIVE_STACK_ID = "pos";
/** Recharts stackId for the below-axis (liability / negative-contribution) group. */
export const NEGATIVE_STACK_ID = "neg";

/** One point on the value-over-time axis with its per-member decomposition. */
export interface StackPoint {
  /** X-axis value (ISO date or "YYYY-MM" month label). */
  date: string;
  /** The aggregate value at this point — the stack's outer boundary must equal it. */
  total: number;
  /** Per-member contributions at this point. Names pre-resolved by the caller. */
  members: BreakdownMember[];
}

export interface BuildStackedSeriesOptions {
  /** Max named bands before the tail collapses into "Other". Default 10. */
  maxMembers?: number;
  /** Property name to write the X value under in each row. Default "date". */
  dateKey?: string;
  /** Label for the residual band. Default "Other". */
  otherLabel?: string;
  /**
   * FINLYNQ-187 — split mixed-sign bands into a positive (above-axis) and a
   * negative (below-axis) Recharts stack. When true, each legend entry gets a
   * `stackId` of {@link POSITIVE_STACK_ID} / {@link NEGATIVE_STACK_ID} chosen by
   * the SIGN of that band's summed contribution across the window, so liability
   * accounts (whose `members[]` contribution is negative) render below the zero
   * axis instead of stacking as positive bands above it. The band VALUES are
   * untouched (still signed), so the reconciled net — top of the positive stack
   * minus bottom of the negative stack — still equals the aggregate `total` at
   * every point. Default false (legacy single-stack behaviour, byte-identical
   * for the all-same-sign Income/Expenses + Performance stacks).
   */
  signSplit?: boolean;
}

/** One coloured band in the legend / one `<Area>` to render, in stack order. */
export interface StackLegendEntry {
  /** Data key on each row (e.g. "m_42" or "__other"). */
  key: string;
  /** Display name for the legend. */
  name: string;
  /** Palette colour. */
  color: string;
  /** True for the collapsed "Other" residual band. */
  isOther: boolean;
  /**
   * FINLYNQ-187 — only populated when `signSplit` is enabled: the Recharts
   * stackId this band belongs to ({@link POSITIVE_STACK_ID} for an above-axis
   * asset band, {@link NEGATIVE_STACK_ID} for a below-axis liability band).
   * Undefined in legacy (single-stack) mode — callers keep their own literal
   * stackId, so same-sign charts are unaffected.
   */
  stackId?: string;
}

export interface StackedSeriesResult {
  /** Recharts rows: `{ [dateKey]: string, [key]: number, … }`. */
  rows: Array<Record<string, string | number>>;
  /**
   * Bands in render order (top-N desc by average contribution, then "Other"
   * last). Drives both the `<Area stackId>` list and the legend below the chart.
   */
  legend: StackLegendEntry[];
}

/** Stable string key for a member (its id when present, else its name). */
function memberKey(m: BreakdownMember): string {
  const raw = m.id != null ? String(m.id) : `name:${m.name}`;
  return `${STACK_KEY_PREFIX}${raw}`;
}

/**
 * Pick the colour for the i-th band from the shared palette, cycling if there
 * are more bands than palette slots. "Other" always uses the neutral slot.
 */
function bandColor(index: number): string {
  const palette = CHART_COLORS.categories;
  return palette[index % palette.length];
}

/**
 * Build the stacked-series rows + legend from per-point member breakdowns.
 *
 * Invariants (exercised by the unit test):
 *  - legend has ≤ maxMembers named bands + at most ONE "Other" band (present
 *    iff the window has more than maxMembers distinct contributing members).
 *  - For every row, Σ(kept band values) + __other === that point's `total`
 *    (modulo float) — the outer stack boundary equals the aggregate.
 *  - Ranking is by AVERAGE |value| across all points (re-derived per call, so a
 *    new time window re-ranks). Zero-only members never enter the top-N.
 *  - "Other" band is omitted entirely (no key on rows, no legend entry) when no
 *    member falls outside the top-N.
 */
export function buildStackedSeries(
  points: StackPoint[],
  options: BuildStackedSeriesOptions = {},
): StackedSeriesResult {
  const maxMembers = options.maxMembers ?? 10;
  const dateKey = options.dateKey ?? "date";
  const otherLabel = options.otherLabel ?? "Other";
  const signSplit = options.signSplit ?? false;

  // ── 1. Aggregate each member across the window: sum |value| + signed sum + name
  const agg = new Map<
    string,
    { key: string; name: string; absSum: number; signedSum: number }
  >();
  for (const p of points) {
    for (const m of p.members) {
      if (!Number.isFinite(m.value) || m.value === 0) continue;
      const key = memberKey(m);
      const cur = agg.get(key) ?? { key, name: m.name, absSum: 0, signedSum: 0 };
      cur.absSum += Math.abs(m.value);
      // Signed sum drives the FINLYNQ-187 above/below-axis stack assignment: a
      // member whose net contribution over the window is negative (a liability)
      // lands in the below-axis stack even if a single point flips sign.
      cur.signedSum += m.value;
      // Prefer the most recent non-empty name we see (names are stable per key).
      if (m.name) cur.name = m.name;
      agg.set(key, cur);
    }
  }

  const n = points.length || 1;
  // Average absolute contribution over the window drives the ranking.
  const ranked = [...agg.values()].sort((a, b) => {
    const da = b.absSum - a.absSum;
    if (da !== 0) return da;
    return a.name.localeCompare(b.name);
  });

  const topKeys = ranked.slice(0, maxMembers);
  const hasOther = ranked.length > maxMembers;
  const topKeySet = new Set(topKeys.map((r) => r.key));

  // FINLYNQ-187 — when sign-splitting, classify each band into the above-axis
  // (positive) or below-axis (negative) Recharts stack by the sign of its net
  // contribution over the window. A negative signedSum (a liability account)
  // → below-axis. Zero/positive → above-axis. `undefined` in legacy mode.
  const stackIdFor = (signedSum: number): string | undefined =>
    signSplit ? (signedSum < 0 ? NEGATIVE_STACK_ID : POSITIVE_STACK_ID) : undefined;

  // ── 2. Build the legend (top-N in rank order, then "Other" in the last slot) ──
  const legend: StackLegendEntry[] = topKeys.map((r, i) => ({
    key: r.key,
    name: r.name,
    color: bandColor(i),
    isOther: false,
    stackId: stackIdFor(r.signedSum),
  }));
  if (hasOther) {
    // The residual's net sign over the window decides which stack it joins so
    // the below-axis tail of mixed-sign liabilities still reconciles.
    const topSignedSum = topKeys.reduce((s, r) => s + r.signedSum, 0);
    const totalSum = points.reduce((s, p) => s + p.total, 0);
    const otherSignedSum = totalSum - topSignedSum;
    legend.push({
      key: OTHER_STACK_KEY,
      name: otherLabel,
      color: CHART_COLORS.neutral,
      isOther: true,
      stackId: stackIdFor(otherSignedSum),
    });
  }

  // ── 3. Emit one row per point ────────────────────────────────────────────
  const rows: Array<Record<string, string | number>> = points.map((p) => {
    const row: Record<string, string | number> = { [dateKey]: p.date };
    // Seed every kept band to 0 so absent members render as a flat band (and
    // Recharts doesn't drop the series on a gap).
    for (const k of topKeySet) row[k] = 0;
    let keptSum = 0;
    for (const m of p.members) {
      if (!Number.isFinite(m.value) || m.value === 0) continue;
      const key = memberKey(m);
      if (topKeySet.has(key)) {
        row[key] = (row[key] as number) + m.value;
        keptSum += m.value;
      }
    }
    if (hasOther) {
      // SIGNED residual preserves the aggregate: kept + other === total.
      row[OTHER_STACK_KEY] = Math.round((p.total - keptSum) * 100) / 100;
    }
    // Round kept bands too so the rendered stack ties to the rounded total.
    for (const k of topKeySet) {
      row[k] = Math.round((row[k] as number) * 100) / 100;
    }
    return row;
  });

  void n; // average is implicit in absSum ordering; kept for documentation parity
  return { rows, legend };
}
