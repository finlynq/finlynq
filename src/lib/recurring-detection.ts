// Shared staleness/cadence detection used by MCP `get_recurring_transactions`
// and `get_cash_flow_forecast` (issue #235). Keeps both tools moving in
// lockstep when the threshold or drop-reason taxonomy is tweaked.

/**
 * Threshold used to flag a recurring item as stale. A row is `flagged` when
 * `daysSinceLast > expectedCadenceDays * STALENESS_THRESHOLD_MULTIPLIER`.
 * Lives here (not at the callsite) so both tools share the value.
 */
export const STALENESS_THRESHOLD_MULTIPLIER = 1.5;

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
  /** Average row amount across the group (signed; consumers may abs/normalize). */
  avg: number;
  /** True when avg-row deviation < 20% of mean magnitude. */
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

  const consistent = sorted.every(
    (t) => Math.abs(Number(t.amount) - avg) / Math.abs(avg) < 0.2,
  );
  if (!consistent) {
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

  return {
    lastDate,
    expectedCadenceDays,
    daysSinceLast,
    avg,
    consistent: true,
    detected: true,
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
