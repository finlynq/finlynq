// Shared staleness/cadence detection used by MCP `get_recurring_transactions`
// and `get_cash_flow_forecast` (issue #235). Keeps both tools moving in
// lockstep when the threshold or drop-reason taxonomy is tweaked.

/**
 * Threshold used to flag a recurring item as stale. A row is `flagged` when
 * `daysSinceLast > expectedCadenceDays * STALENESS_THRESHOLD_MULTIPLIER`.
 * Lives here (not at the callsite) so both tools share the value.
 */
export const STALENESS_THRESHOLD_MULTIPLIER = 1.5;

/**
 * Amount-consistency thresholds (GH #307, Problem 3). A group is a real
 * recurrence when EITHER every row sits within `AMOUNT_SINGLE_MEAN_BAND` of one
 * mean (the classic single-amount case), OR the cadence is regular
 * (coefficient of variation of the inter-row gaps <= `INTERVAL_COV_MAX`) AND
 * the amounts fall into <=2 tight clusters (each member within
 * `AMOUNT_CLUSTER_TOL` of its cluster mean) — a biweekly paycheck alternating
 * two amounts >=1.5x apart, overtime/bonus/deduction, etc. Before this, the
 * single-mean-only test flattened bimodal-but-regular income to one mean and
 * dropped it as `inconsistent`.
 */
export const AMOUNT_SINGLE_MEAN_BAND = 0.2;
export const INTERVAL_COV_MAX = 0.25;
export const AMOUNT_CLUSTER_TOL = 0.15;

export type RecurringDropReason =
  | "too_few_occurrences"
  | "amount_too_small"
  | "inconsistent"
  | "stale";

export type RecurringCadence = {
  /** YYYY-MM-DD of the latest occurrence in the group. */
  lastDate: string;
  /** Whole-day average gap between consecutive sorted occurrences. */
  expectedCadenceDays: number;
  /** Whole days between today (UTC) and `lastDate`. */
  daysSinceLast: number;
  /**
   * The amount to project each cadence (signed; consumers may abs/normalize).
   * For a single-amount recurrence this is the group mean; for a regular
   * bimodal recurrence it is the MOST-RECENT cluster's mean (GH #307), so the
   * forecast continues off the amount that actually landed last.
   */
  avg: number;
  /**
   * True when the group is a real recurrence — either every row within
   * `AMOUNT_SINGLE_MEAN_BAND` of a single mean, or a regular cadence whose
   * amounts form <=2 tight clusters (bimodal). False otherwise.
   */
  consistent: boolean;
  /** True when count >= 3, |avg| >= 0.01, and `consistent`. */
  detected: boolean;
  /** Set when `detected === false`; explains why the group was dropped. */
  dropReason?: RecurringDropReason;
};

/**
 * Compute cadence + drop-reason for a sorted list of recurring candidate
 * rows (already grouped by payee). Pure: no DB I/O. Caller passes today's
 * date string so unit tests can control "now" deterministically.
 */
export function analyzeRecurringGroup(
  group: { date: string; amount: number }[],
  today: string,
): RecurringCadence {
  if (group.length < 3) {
    const last = group.length > 0 ? group[group.length - 1].date : today;
    return {
      lastDate: last,
      expectedCadenceDays: 0,
      daysSinceLast: daysBetweenDates(today, last),
      avg: group.length > 0 ? group.reduce((s, t) => s + Number(t.amount), 0) / group.length : 0,
      consistent: false,
      detected: false,
      dropReason: "too_few_occurrences",
    };
  }

  const sorted = [...group].sort((a, b) => a.date.localeCompare(b.date));
  const avg = sorted.reduce((s, t) => s + Number(t.amount), 0) / sorted.length;
  const lastDate = sorted[sorted.length - 1].date;
  const daysSinceLast = daysBetweenDates(today, lastDate);

  // Inter-row interval average. With group.length >= 3, intervals.length >= 2.
  const intervals: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const d1 = new Date(sorted[i - 1].date + "T00:00:00").getTime();
    const d2 = new Date(sorted[i].date + "T00:00:00").getTime();
    intervals.push(Math.round((d2 - d1) / 86400000));
  }
  const expectedCadenceDays = intervals.reduce((s, d) => s + d, 0) / intervals.length;

  if (Math.abs(avg) < 0.01) {
    return {
      lastDate,
      expectedCadenceDays,
      daysSinceLast,
      avg,
      consistent: false,
      detected: false,
      dropReason: "amount_too_small",
    };
  }

  const amounts = sorted.map((t) => Number(t.amount));

  // Path (a): the classic single-amount recurrence — every row within
  // AMOUNT_SINGLE_MEAN_BAND of the group mean. Project the group mean.
  const singleMeanConsistent = amounts.every(
    (a) => Math.abs(a - avg) / Math.abs(avg) < AMOUNT_SINGLE_MEAN_BAND,
  );
  if (singleMeanConsistent) {
    return { lastDate, expectedCadenceDays, daysSinceLast, avg, consistent: true, detected: true };
  }

  // Path (b): a regular cadence whose amounts alternate between <=2 tight
  // clusters is still a real recurrence (GH #307). Score interval regularity
  // (CoV of the gaps) and cluster the amounts; require the minority cluster to
  // hold >=2 occurrences so a single outlier among constant amounts stays
  // `inconsistent` rather than becoming its own cluster. Project off the
  // most-recent cluster's mean.
  const intervalCoV = coefficientOfVariation(intervals);
  const clusters = clusterAmounts(amounts, AMOUNT_CLUSTER_TOL);
  if (intervalCoV <= INTERVAL_COV_MAX && clusters !== null && clusters.minoritySize >= 2) {
    const recent = amounts[amounts.length - 1];
    const projectAvg = clusters.means.reduce((best, m) =>
      Math.abs(recent - m) < Math.abs(recent - best) ? m : best,
    );
    return {
      lastDate,
      expectedCadenceDays,
      daysSinceLast,
      avg: projectAvg,
      consistent: true,
      detected: true,
    };
  }

  return {
    lastDate,
    expectedCadenceDays,
    daysSinceLast,
    avg,
    consistent: false,
    detected: false,
    dropReason: "inconsistent",
  };
}

/**
 * `flagged === true` when the group hasn't seen activity for more than
 * `STALENESS_THRESHOLD_MULTIPLIER * expectedCadenceDays`. Returns false when
 * cadence is 0 (degenerate).
 */
export function isStale(cadence: RecurringCadence): boolean {
  if (cadence.expectedCadenceDays <= 0) return false;
  return cadence.daysSinceLast > cadence.expectedCadenceDays * STALENESS_THRESHOLD_MULTIPLIER;
}

function daysBetweenDates(later: string, earlier: string): number {
  const a = new Date(later + "T00:00:00").getTime();
  const b = new Date(earlier + "T00:00:00").getTime();
  return Math.round((a - b) / 86400000);
}

function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * Coefficient of variation (stddev / |mean|) of a numeric series — the
 * regularity score for the inter-row gap sequence. Returns 0 for a constant
 * series and Infinity when the mean is ~0 (degenerate, treated as irregular).
 */
function coefficientOfVariation(values: number[]): number {
  if (values.length === 0) return 0;
  const m = mean(values);
  if (Math.abs(m) < 1e-9) return Infinity;
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance) / Math.abs(m);
}

/** Every member within `tol` (relative) of the series mean. A near-zero mean
 *  can't be judged for relative tightness → treated as not tight. */
function isTightCluster(values: number[], tol: number): boolean {
  const m = mean(values);
  if (Math.abs(m) < 0.01) return false;
  return values.every((v) => Math.abs(v - m) / Math.abs(m) <= tol);
}

/**
 * Cluster a group's amounts into at most two tight groups (each member within
 * `tol` of its cluster's mean). Returns the cluster means and the size of the
 * smaller cluster, or null when the amounts don't fit <=2 tight groups (3+
 * scattered levels). A single spike among otherwise-constant amounts yields a
 * `minoritySize` of 1, which the caller rejects as an outlier rather than a
 * bimodal recurrence.
 */
function clusterAmounts(
  amounts: number[],
  tol: number,
): { means: number[]; minoritySize: number } | null {
  if (amounts.length === 0) return null;
  if (isTightCluster(amounts, tol)) {
    return { means: [mean(amounts)], minoritySize: amounts.length };
  }
  // Two-cluster split at the widest gap between sorted amounts (1-D 2-means).
  const sorted = [...amounts].sort((a, b) => a - b);
  let splitAt = -1;
  let widestGap = -Infinity;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > widestGap) {
      widestGap = gap;
      splitAt = i;
    }
  }
  if (splitAt < 1) return null;
  const low = sorted.slice(0, splitAt);
  const high = sorted.slice(splitAt);
  if (!isTightCluster(low, tol) || !isTightCluster(high, tol)) return null;
  return { means: [mean(low), mean(high)], minoritySize: Math.min(low.length, high.length) };
}
