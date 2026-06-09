/**
 * chart-series.ts — shared pure util for value-over-time line/area charts.
 *
 * Provides two capabilities that all three value-over-time charts need:
 *   1. Tighten the Y-axis — pad just above/below the data range instead of
 *      anchoring at 0, so a ~$208k series fills the vertical space.
 *   2. Downsample long ranges — cap rendered points at `maxPoints` (default 200),
 *      stepping day → week → month by date span.  Short ranges (≤200 pts)
 *      are returned verbatim so 1M/3M/6M views stay pixel-identical.
 *
 * SCOPE: value-over-time **line/area** charts ONLY.  Bar/pie/Sankey/sparkline/
 * projection charts are out of scope — they must stay anchored at 0.
 *
 * PURE / CLIENT-SAFE: zero deps, no @/db, no next/server, no Date.now().
 * Granularity derives from the data's own first/last ISO dates — same discipline
 * as src/lib/net-worth-history.ts.  Safe to import from "use client" components.
 *
 * Live-hero last-point invariant: the final plotted point equals the input's
 * last row value exactly — the final bucket's last row is force-kept as an
 * endpoint anchor.  Every kept value is an original input member (no averaging).
 */

// ── Public types ─────────────────────────────────────────────────────────────

export interface PrepareTimeSeriesOptions<T extends object = object> {
  /** Property containing ISO "YYYY-MM-DD" date strings. */
  dateKey: keyof T;
  /** One or more value keys; the union across all defines the Y domain. */
  valueKeys: (keyof T)[];
  /** Maximum number of rendered points.  Default 200. */
  maxPoints?: number;
  /** Fractional padding added to each side of the data range.  Default 0.05. */
  domainPadPct?: number;
  /**
   * When true (default) an all-positive series never floors below 0 — the
   * tightened domain still lifts well above 0 for a ~$208k series but won't
   * show negative space.  Pass false for % series that legitimately go negative
   * (e.g. the benchmark chart).
   */
  clampZeroFloor?: boolean;
}

export interface PreparedSeries<T extends object = object> {
  /** Downsampled (or verbatim) rows ready for the chart. */
  data: T[];
  /** [min, max] numeric domain tuple for <YAxis domain={domain} />. */
  domain: [number, number];
  /**
   * true when min < 0 < max after padding — callers use this to show/hide a
   * <ReferenceLine y={0} />.
   */
  spansZero: boolean;
  granularity: "day" | "week" | "month";
}

// ── Exported helpers (also used by tests) ────────────────────────────────────

/**
 * Choose the granularity that keeps the result within maxPoints.
 * spanDays = UTC-midnight diff between first and last ISO dates.
 */
export function pickGranularity(
  n: number,
  spanDays: number,
  maxPoints: number,
): "day" | "week" | "month" {
  if (n <= maxPoints) return "day";
  if (Math.ceil(spanDays / 7) <= maxPoints) return "week";
  return "month";
}

/**
 * Map an ISO date string to its bucket key for the given granularity.
 * - day  → the date itself ("YYYY-MM-DD")
 * - week → Monday-anchored ISO week label ("YYYY-Www") — any date maps to
 *          the same bucket regardless of range start.
 * - month → "YYYY-MM"
 */
export function bucketKey(date: string, granularity: "day" | "week" | "month"): string {
  if (granularity === "day") return date;
  if (granularity === "month") return date.slice(0, 7);
  // week: find the preceding Monday (UTC)
  const d = new Date(`${date}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0=Sun…6=Sat
  const diff = dow === 0 ? -6 : 1 - dow; // days to last Monday
  d.setUTCDate(d.getUTCDate() + diff);
  const year = d.getUTCFullYear();
  // ISO week number
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const startOfWeek1 = new Date(jan4);
  startOfWeek1.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  const weekNum = Math.round((d.getTime() - startOfWeek1.getTime()) / (7 * 86400000)) + 1;
  const ww = String(weekNum).padStart(2, "0");
  // handle week belonging to next year
  const yy = d >= new Date(Date.UTC(year, 11, 29)) &&
    weekNum === 1 ? year + 1 : year;
  return `${yy}-W${ww}`;
}

/**
 * Compute the [min, max] Y-axis domain from a flat array of numeric values.
 *
 * - Skips null / undefined / NaN (needed for sparse benchmark series).
 * - Normal range: pads both sides by `range * padPct`.
 * - All-equal / single point: uses `max(|v| * padPct, 1)` as the band.
 * - clampZeroFloor: when true and all values ≥ 0, floor is clamped to ≥ 0.
 * - Empty input: returns [0, 1].
 */
export function niceDomain(
  values: (number | null | undefined)[],
  opts?: { padPct?: number; clampZeroFloor?: boolean },
): [number, number] {
  const padPct = opts?.padPct ?? 0.05;
  const clampZeroFloor = opts?.clampZeroFloor ?? true;

  const nums = values.filter(
    (v): v is number => v != null && !Number.isNaN(v),
  );
  if (nums.length === 0) return [0, 1];

  let min = nums[0];
  let max = nums[0];
  for (const v of nums) {
    if (v < min) min = v;
    if (v > max) max = v;
  }

  if (min === max) {
    const band = Math.max(Math.abs(max) * padPct, 1);
    const floor = clampZeroFloor && min >= 0 ? Math.max(min - band, 0) : min - band;
    return [floor, max + band];
  }

  const range = max - min;
  const pad = range * padPct;
  let floor = min - pad;
  const ceil = max + pad;

  if (clampZeroFloor && min >= 0) {
    floor = Math.max(floor, 0);
  }

  return [floor, ceil];
}

// ── UTC span helper ───────────────────────────────────────────────────────────

function utcDayDiff(isoA: string, isoB: string): number {
  const a = new Date(`${isoA}T00:00:00Z`).getTime();
  const b = new Date(`${isoB}T00:00:00Z`).getTime();
  return Math.round(Math.abs(b - a) / 86400000);
}

// ── Primary entry point ───────────────────────────────────────────────────────

/**
 * Prepare a time series for a Recharts line/area chart.
 *
 * Steps:
 * 1. Sort ascending by dateKey.
 * 2. If n ≤ maxPoints → return verbatim (only compute domain).
 * 3. Pick granularity from span.
 * 4. Bucket by granularity; representative = last row in each bucket.
 * 5. Force-keep first and last input rows as endpoint anchors.
 * 6. Compute domain across all valueKeys (skipping null/undefined/NaN).
 */
export function prepareTimeSeries<T extends object>(
  data: T[],
  opts: PrepareTimeSeriesOptions<T>,
): PreparedSeries<T> {
  const {
    dateKey,
    valueKeys,
    maxPoints = 200,
    domainPadPct = 0.05,
    clampZeroFloor = true,
  } = opts;

  // Cast to a looser record type for internal property access while keeping the
  // public-facing T for the return type.  Callers still get the original T[].
  type Rec = Record<string | symbol, unknown>;
  const dk = dateKey as string | symbol;

  // ── 1. Sort defensively ──────────────────────────────────────────────────
  const sorted = [...data].sort((a, b) => {
    const da = String((a as Rec)[dk]);
    const db = String((b as Rec)[dk]);
    return da < db ? -1 : da > db ? 1 : 0;
  });

  // ── 2. Collect all values for domain ────────────────────────────────────
  const allValues: (number | null | undefined)[] = [];
  for (const row of sorted) {
    for (const vk of valueKeys) {
      const v = (row as Rec)[vk as string | symbol];
      allValues.push(v == null ? null : Number(v));
    }
  }
  const domain = niceDomain(allValues, { padPct: domainPadPct, clampZeroFloor });
  const spansZero = domain[0] < 0 && domain[1] > 0;

  // ── 3. Passthrough if already within limit ───────────────────────────────
  if (sorted.length <= maxPoints) {
    const granularity = "day";
    return { data: sorted, domain, spansZero, granularity };
  }

  // ── 4. Pick granularity ──────────────────────────────────────────────────
  const firstDate = String((sorted[0] as Rec)[dk]);
  const lastDate = String((sorted[sorted.length - 1] as Rec)[dk]);
  const spanDays = utcDayDiff(firstDate, lastDate);
  const granularity = pickGranularity(sorted.length, spanDays, maxPoints);

  // ── 5. Bucket: last row per bucket ───────────────────────────────────────
  const bucketMap = new Map<string, T>();
  for (const row of sorted) {
    const bk = bucketKey(String((row as Rec)[dk]), granularity);
    bucketMap.set(bk, row); // later row overwrites → last in bucket wins
  }
  const bucketed = Array.from(bucketMap.values());

  // ── 6. Force-keep endpoints ──────────────────────────────────────────────
  const firstRow = sorted[0];
  const lastRow = sorted[sorted.length - 1];
  const firstDate0 = String((firstRow as Rec)[dk]);
  const lastDate0 = String((lastRow as Rec)[dk]);

  const hasFirst = bucketed.some((r) => String((r as Rec)[dk]) === firstDate0);
  const hasLast = bucketed.some((r) => String((r as Rec)[dk]) === lastDate0);

  let result = bucketed;
  if (!hasFirst) result = [firstRow, ...result];
  if (!hasLast) result = [...result, lastRow];

  // De-dupe dates (stable, sorted order already guaranteed by bucketing sorted input)
  const seen = new Set<string>();
  result = result.filter((r) => {
    const d = String((r as Rec)[dk]);
    if (seen.has(d)) return false;
    seen.add(d);
    return true;
  });

  // Re-sort after potential prepend of firstRow
  result.sort((a, b) => {
    const da = String((a as Rec)[dk]);
    const db = String((b as Rec)[dk]);
    return da < db ? -1 : da > db ? 1 : 0;
  });

  return { data: result, domain, spansZero, granularity };
}
