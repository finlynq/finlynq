/**
 * Debt-service numerator for the DTI health component (GH #333 follow-up).
 *
 * WHY THIS REPLACED THE OLD PREDICATE
 * -----------------------------------
 * DTI used to count "unpaired negative rows on a liability account". Liability
 * balances are stored NEGATIVE-when-owed, so that predicate selects new
 * BORROWING — charges, fees, accrued interest — while an actual payment is
 * POSITIVE on the liability and carries a `link_id` (its cash leg), which the
 * same predicate excluded. The number labelled "debt-to-income" was therefore
 * closer to card-spend ÷ income. Measured live on the demo dataset 2026-08-22:
 * the component was being dropped from the score entirely, because charges
 * exceeded 1.2× total liabilities and tripped the anomaly backstop.
 *
 * THE REPLACEMENT — two sources, split by what we actually know
 * ------------------------------------------------------------
 *  1. TRACKED LOANS (`loans` rows) → SCHEDULED service. For an amortizing debt
 *     the contractual payment is the honest measure and is stable month to
 *     month, which is what a lender means by DTI. Derived from the same pure
 *     `buildLoanSchedule` the /loans page uses, so the two can never disagree.
 *  2. UNTRACKED LIABILITIES (a liability account no loan points at) → REALIZED
 *     payments: money moving INTO the account (positive amount, `link_id` set).
 *     For a revolving card that IS the debt service — you pay what you owe —
 *     and there is no schedule to read.
 *
 * The split is also what keeps it from double-counting: a payment transferred
 * into a loan-linked account would otherwise be counted once as a scheduled
 * payment and once as a realized one, so realized payments are scoped to
 * accounts with NO loan.
 *
 * DEK-FREE BY CONSTRUCTION — and this is load-bearing, not incidental. The MCP
 * caller passes `dek: null` explicitly ([mcp-server/tools/reads.ts]), so any
 * DEK-dependent branch would make the same user's DTI differ between the web
 * dashboard and their AI assistant — the exact cross-surface split FINLYNQ-183
 * collapsed. That is why "credit-card interest and fees" are NOT separated out
 * here: telling an interest charge from a grocery charge needs the category
 * name, which lives in `name_ct` behind the DEK. Interest on a revolving card
 * is instead captured implicitly, since paying it off is part of the realized
 * payment.
 *
 * KNOWN CAVEAT (deliberate, surfaced via `reliable`): a transactor who pays
 * their card in full every month books realized payments equal to their card
 * SPEND, which overstates debt service. `reliable` is false whenever any
 * untracked liability contributed, so the UI caveats the figure rather than
 * presenting it as authoritative. Tracking the card as a loan moves it onto
 * the scheduled path and clears the flag.
 *
 * Pure: no db, no I/O, no clock. The caller supplies rows, the window, and an
 * FX converter.
 */

import { buildLoanSchedule } from "@/lib/loan-calculator";

/** The plaintext `loans` columns this needs — no `name_ct`, so no DEK. */
export type DebtServiceLoan = {
  id: number;
  accountId: number | null;
  currency: string | null;
  principal: number;
  annualRate: number;
  termMonths: number | null;
  startDate: string;
  paymentAmount: number | null;
  paymentFrequency: string | null;
  extraPayment: number | null;
  residualValue: number | null;
};

export type DebtServiceInput = {
  loans: DebtServiceLoan[];
  /** Realized payments INTO liability accounts that no loan points at, grouped
   *  by currency. Amounts are positive (money reducing the debt). */
  untrackedPayments: Array<{ currency: string | null; total: number }>;
  /** Inclusive ISO window bounds, e.g. the trailing 12 months. */
  windowStart: string;
  windowEnd: string;
  /** Native amount → reporting currency. Caller owns the rate source. */
  convert: (amount: number, currency: string | null) => number;
};

export type DebtServiceResult = {
  /** Trailing-window debt service in the reporting currency. */
  total: number;
  /** Portion from scheduled loan payments. */
  scheduled: number;
  /** Portion from realized payments into untracked liabilities. */
  realized: number;
  /** Loans that contributed at least one month of service in the window. */
  loansCounted: number;
  /** True when nothing came from the realized (over-counting) path. */
  reliable: boolean;
};

/** Whole months of overlap between two inclusive date ranges, clamped at 0.
 *
 *  Months, not days, because the unit being multiplied is a MONTHLY payment. A
 *  loan opened mid-window must contribute only the months it actually existed —
 *  charging a full 12 to a loan taken out last month is the same class of error
 *  as the opening-balance bug this replaced.
 *
 *  `aEnd`/`bEnd` are inclusive; a null `aEnd` means "still open". Partial
 *  months count, so a loan alive for 45 days contributes ~1.5. */
export function monthsOverlapping(
  aStart: string,
  aEnd: string | null,
  bStart: string,
  bEnd: string,
): number {
  const t = (s: string) => new Date(s + "T00:00:00Z").getTime();
  const start = Math.max(t(aStart), t(bStart));
  const end = Math.min(aEnd ? t(aEnd) : t(bEnd), t(bEnd));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  const AVG_MONTH_MS = 30.436875 * 86400000; // mean Gregorian month
  return (end - start) / AVG_MONTH_MS;
}

/** Scheduled service a single loan contributes across the window, in the
 *  loan's OWN currency. Returns 0 for a loan that cannot be scheduled — a
 *  `LoanValidationError` (payment too small to amortize, zero term) must not
 *  take the whole health score down with it. */
export function scheduledServiceForLoan(
  loan: DebtServiceLoan,
  windowStart: string,
  windowEnd: string,
): number {
  let monthly: number;
  let payoffDate: string | null;
  try {
    const summary = buildLoanSchedule({
      principal: loan.principal,
      annualRate: loan.annualRate,
      startDate: loan.startDate,
      termMonths: loan.termMonths,
      paymentAmount: loan.paymentAmount,
      paymentFrequency: loan.paymentFrequency,
      extraPayment: loan.extraPayment,
      residualValue: loan.residualValue,
    });
    monthly = summary.monthlyEquivalentPayment;
    payoffDate = summary.payoffDate;
  } catch {
    return 0;
  }
  if (!Number.isFinite(monthly) || monthly <= 0) return 0;

  const months = monthsOverlapping(loan.startDate, payoffDate, windowStart, windowEnd);
  return monthly * months;
}

/** Trailing-window debt service, in the reporting currency. */
export function computeDebtService(input: DebtServiceInput): DebtServiceResult {
  const { loans, untrackedPayments, windowStart, windowEnd, convert } = input;

  let scheduled = 0;
  let loansCounted = 0;
  for (const loan of loans) {
    const native = scheduledServiceForLoan(loan, windowStart, windowEnd);
    if (native <= 0) continue;
    loansCounted += 1;
    scheduled += convert(native, loan.currency);
  }

  let realized = 0;
  for (const row of untrackedPayments) {
    const amount = Number(row.total);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    realized += convert(amount, row.currency);
  }

  return {
    total: scheduled + realized,
    scheduled,
    realized,
    loansCounted,
    reliable: realized === 0,
  };
}
