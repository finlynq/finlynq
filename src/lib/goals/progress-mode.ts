/**
 * How a goal measures progress (GH #423, 2026-11-20). Pure, client-safe.
 *
 *   balance  (default, every goal before this): progress is the linked
 *            accounts' balance now. Good for "have 10,000 in savings".
 *   growth   progress is how much the linked accounts' balance has grown since
 *            the goal's start date: balance now minus balance at the end of the
 *            day before `startDate`. Good for "save 5,000 more", when the money
 *            sits in an account that already holds other savings, or when
 *            several goals share one account.
 *
 * Growth works for a liability too: paying a card down from -3,000 to -1,000
 * is +2,000 of growth, so it reads as progress without the debt_payoff flip.
 */

export const GOAL_PROGRESS_MODES = ["balance", "growth"] as const;
export type GoalProgressMode = (typeof GOAL_PROGRESS_MODES)[number];

export function isGoalProgressMode(v: unknown): v is GoalProgressMode {
  return typeof v === "string" && (GOAL_PROGRESS_MODES as readonly string[]).includes(v);
}

/** Read a stored mode; anything unknown or missing is the original `balance`. */
export function normalizeProgressMode(v: unknown): GoalProgressMode {
  return isGoalProgressMode(v) ? v : "balance";
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(d: string): boolean {
  if (!ISO_DATE.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

/**
 * Why a goal's mode settings can't be saved, or null when they can. A growth
 * goal needs a real start date that isn't in the future (there is nothing to
 * measure yet) and at least one linked account (there is no balance to grow).
 */
export function growthGoalRefusal(args: {
  progressMode: GoalProgressMode;
  startDate: string | null | undefined;
  accountIds: readonly number[];
  today: string;
}): string | null {
  if (args.progressMode !== "growth") return null;
  if (!args.startDate) return "A growth goal needs a start date.";
  if (!isRealDate(args.startDate)) return `"${args.startDate}" is not a date (use YYYY-MM-DD).`;
  if (args.startDate > args.today) return "A growth goal's start date can't be in the future.";
  if (args.accountIds.length === 0) {
    return "A growth goal measures how much its accounts grow, so link at least one account.";
  }
  return null;
}

/** The day before `startDate`: the balance at its end is the starting point. */
export function dayBefore(startDate: string): string {
  const t = new Date(`${startDate}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}
