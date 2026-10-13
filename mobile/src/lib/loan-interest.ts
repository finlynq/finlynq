// Loan interest entries: which payments have their interest booked, which are
// due, and whether the lender is charging what the schedule calculates.
//
// A MIRROR of the web's pure `src/lib/loans/interest-plan.ts` (pf-app); keep the
// two in sync. The server reads the ledger and hands back raw interest
// transactions; crediting each one to a payment happens here, with the same
// rule the web panel, the server and the MCP tool use.
//
// The model: a loan payment is a plain transfer into the loan account. The
// interest is a SEPARATE expense on that same account. It adds to what is owed,
// the payment takes it off, and the balance falls by the principal.

import { formatCurrency } from "./format";

/** The fields of a schedule row this module needs. */
export type InterestScheduleRow = { period: number; date: string; interest: number };

/** One interest transaction on the loan account (amount as stored: negative). */
export type InterestTx = { transactionId: number; date: string; amount: number };

/** What the ledger holds for one payment. */
export type BookedInterest = {
  /** Interest charged, as a positive figure (refunds net against charges). */
  amount: number;
  transactionIds: number[];
};

/** Interest below half a cent rounds to nothing and is not worth an entry. */
const MIN_INTEREST = 0.005;
const DAY_MS = 86_400_000;

const round2 = (n: number) => Math.round(n * 100) / 100;
const dayNumber = (ymd: string) => Math.round(Date.parse(`${ymd}T00:00:00Z`) / DAY_MS);

/**
 * Credit each interest transaction to the payment whose date is nearest (a tie
 * goes to the earlier payment). Lenders rarely post interest on the exact
 * payment date, so an exact-date match would miss most of them.
 *
 * A transaction more than one payment interval outside the schedule's own date
 * range belongs to no payment and comes back in `unmatched`. A payment whose
 * transactions net to nothing (a charge and its reversal) still reads as due.
 */
export function matchInterestToSchedule(
  schedule: readonly InterestScheduleRow[],
  txs: readonly InterestTx[],
): { booked: Map<string, BookedInterest>; unmatched: InterestTx[] } {
  const booked = new Map<string, BookedInterest>();
  const unmatched: InterestTx[] = [];
  if (!schedule.length) return { booked, unmatched: [...txs] };

  const days = schedule.map((r) => dayNumber(r.date));
  const interval = days.length > 1 ? Math.max(1, days[1] - days[0]) : 31;
  const first = days[0];
  const last = days[days.length - 1];

  for (const tx of txs) {
    const d = dayNumber(tx.date);
    if (!Number.isFinite(d) || d < first - interval || d > last + interval) {
      unmatched.push(tx);
      continue;
    }
    let best = 0;
    for (let i = 1; i < days.length; i++) {
      // Strict `<` keeps the earlier payment on a tie.
      if (Math.abs(days[i] - d) < Math.abs(days[best] - d)) best = i;
    }
    const key = schedule[best].date;
    const entry = booked.get(key) ?? { amount: 0, transactionIds: [] };
    entry.amount = round2(entry.amount - tx.amount);
    entry.transactionIds.push(tx.transactionId);
    booked.set(key, entry);
  }

  for (const [key, entry] of booked) {
    if (entry.amount < MIN_INTEREST) booked.delete(key);
  }
  return { booked, unmatched };
}

/** How many of the most recent booked payments a verdict is based on. */
export const ASSESSMENT_MAX_PERIODS = 3;
/** Booked payments older than this are never part of a verdict. */
export const ASSESSMENT_LOOKBACK_DAYS = 365;
/** Fewer booked payments than this is not a pattern, so no verdict. */
const ASSESSMENT_MIN_PERIODS = 2;

export type InterestAssessment =
  | { status: "insufficient"; periods: number }
  | {
      status: "in_line" | "over" | "under" | "inconsistent";
      periods: number;
      from: string;
      to: string;
      booked: number;
      calculated: number;
      ratio: number;
      suggestedRate: number | null;
      fixedAmount: number | null;
    };

/**
 * Compare what the lender charged with what the schedule calculates.
 *
 * Deliberately short-sighted: only the most recent booked payments count. An
 * extra payment or a change to the loan shifts every later payment, so an
 * older one can differ from today's schedule for a perfectly good reason and
 * must not drive the verdict. Whatever shows the result must say which
 * payments it covers (`interestVerdict` does).
 */
export function assessBookedInterest(
  schedule: readonly InterestScheduleRow[],
  booked: ReadonlyMap<string, BookedInterest>,
  today: string,
  annualRate: number,
): InterestAssessment {
  const oldest = dayNumber(today) - ASSESSMENT_LOOKBACK_DAYS;
  const window = schedule
    .filter(
      (r) =>
        r.date <= today &&
        dayNumber(r.date) >= oldest &&
        r.interest >= MIN_INTEREST &&
        booked.has(r.date),
    )
    .slice(-ASSESSMENT_MAX_PERIODS);
  if (window.length < ASSESSMENT_MIN_PERIODS) {
    return { status: "insufficient", periods: window.length };
  }

  const pairs = window.map((r) => ({ calc: r.interest, got: booked.get(r.date)!.amount }));
  const bookedTotal = round2(pairs.reduce((s, p) => s + p.got, 0));
  const calcTotal = round2(pairs.reduce((s, p) => s + p.calc, 0));
  const ratios = pairs.map((p) => p.got / p.calc).sort((a, b) => a - b);
  const mid = Math.floor(ratios.length / 2);
  const median = ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
  const steady = ratios.every((x) => Math.abs(x - median) <= 0.05 * median);
  // Within 2%, or a cent per payment, is rounding rather than a different rate.
  const inLine =
    Math.abs(bookedTotal - calcTotal) <= Math.max(0.02 * calcTotal, 0.01 * pairs.length);

  const base = {
    periods: window.length,
    from: window[0].date,
    to: window[window.length - 1].date,
    booked: bookedTotal,
    calculated: calcTotal,
    ratio: calcTotal > 0 ? bookedTotal / calcTotal : 1,
  };
  if (inLine) return { status: "in_line", ...base, suggestedRate: null, fixedAmount: null };

  const sameCharge = pairs.every((p) => Math.abs(p.got - pairs[0].got) <= 0.01);
  const calcVaries = Math.max(...pairs.map((p) => p.calc)) - Math.min(...pairs.map((p) => p.calc)) > 0.01;
  const fixedAmount = sameCharge && calcVaries ? round2(pairs[0].got) : null;

  const rate = steady && annualRate > 0 ? round2(annualRate * median) : null;
  const suggestedRate = rate != null && rate !== round2(annualRate) ? rate : null;
  const status = !steady ? "inconsistent" : base.ratio > 1 ? "over" : "under";
  return { status, ...base, suggestedRate, fixedAmount };
}

/** Payments whose date has arrived and whose interest is not in the ledger yet. */
export function dueUnpostedInterest<R extends InterestScheduleRow>(
  schedule: readonly R[],
  bookedDates: ReadonlySet<string>,
  today: string,
): R[] {
  return schedule.filter(
    (r) => r.date <= today && r.interest >= MIN_INTEREST && !bookedDates.has(r.date),
  );
}

/** True when `amount` is a usable interest figure (finite, at least a cent). */
export function isPostableInterest(amount: unknown): amount is number {
  return typeof amount === "number" && Number.isFinite(amount) && Math.abs(amount) >= 0.01;
}

/**
 * The verdict in words, or null when there is nothing to say yet. Same wording
 * as the web's Interest entries tab, including the sentence that names the
 * payments it is based on.
 */
export function interestVerdict(
  a: InterestAssessment,
  currency: string,
  annualRate: number,
): { tone: "ok" | "attention"; title: string; lines: string[] } | null {
  if (a.status === "insufficient") return null;
  const booked = formatCurrency(a.booked, currency);
  const calculated = formatCurrency(a.calculated, currency);
  if (a.status === "in_line") {
    return {
      tone: "ok",
      title: `Your last ${a.periods} booked payments match this schedule.`,
      lines: [`Booked ${booked}, calculated ${calculated}.`],
    };
  }
  const lines = [
    `Over your last ${a.periods} booked payments (${a.from} to ${a.to}): booked ${booked}, calculated ${calculated}` +
      (a.status === "inconsistent"
        ? ". The gap is not steady from one payment to the next, so no single rate explains it."
        : `, which is ${a.ratio.toFixed(2)} times the calculated interest.`),
  ];
  if (a.fixedAmount != null) {
    lines.push(
      `Each of those payments was charged the same ${formatCurrency(a.fixedAmount, currency)}, which looks like a ` +
        "fixed interest amount rather than a rate.",
    );
  }
  if (a.suggestedRate != null) {
    lines.push(
      `A rate of about ${a.suggestedRate}% would produce what was charged. The loan is set to ${annualRate}%.`,
    );
  }
  lines.push(
    `Only the ${ASSESSMENT_MAX_PERIODS} most recent booked payments from the last 12 months are compared. An extra ` +
      "payment or a change to the loan shifts every later payment, so older ones can differ for good reason.",
  );
  return {
    tone: "attention",
    title:
      a.status === "inconsistent"
        ? "Booked interest does not follow this schedule."
        : `Your lender charged ${a.status === "over" ? "more" : "less"} than this schedule calculates.`,
    lines,
  };
}
