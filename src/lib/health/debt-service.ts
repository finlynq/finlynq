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
 *     payments: money moving INTO the account (positive amount). For a
 *     revolving card that is the closest thing to debt service — you pay what
 *     you owe — and there is no schedule to read.
 *
 * The split is also what keeps it from double-counting: a payment transferred
 * into a loan-linked account would otherwise be counted once as a scheduled
 * payment and once as a realized one, so realized payments are scoped to
 * accounts with NO loan.
 *
 * CREDIT-CARD TREATMENT — the realized side is CAPPED AT THE DEBT CARRIED
 * ---------------------------------------------------------------------
 * Reported 2026-08-27: for someone who pays their card in full every month,
 * counting the payments as debt service measures their card SPEND, not their
 * debt. A year of $6,600 of groceries paid off each cycle is not $6,600 of debt
 * service — it is $6,600 of groceries, already counted on the expense side.
 *
 * So a revolving account contributes `min(payments, carriedDebt)`, where
 * `carriedDebt` is the largest balance the account is KNOWN to have owed at a
 * window endpoint: `max(owedAtWindowStart, owedAtWindowEnd)`. Rationale:
 *
 *   - You can only *service* debt that existed. Payments beyond what was ever
 *     carried are paying for charges made inside the window — spending.
 *   - Pay-in-full transactor, nothing carried → contributes 0. This is the
 *     case the user asked to remove, and it falls out of the formula rather
 *     than needing a separate "is this a transactor" heuristic.
 *   - A card opened DURING the window that is now carrying a balance still
 *     counts: `owedAtWindowStart` is 0 but `owedAtWindowEnd` is not, which is
 *     why the cap takes the MAX of the two endpoints rather than just the
 *     opening balance. Capping on the opening balance alone would zero out
 *     every genuinely new debt.
 *   - A revolver paying less than they owe is untouched (`payments <
 *     carriedDebt`), so real debt service is never reduced.
 *
 * The endpoints are an approximation of the peak carried balance — computing a
 * true running maximum needs a windowed scan of every liability row, and the
 * two endpoints already separate a transactor from a revolver. The residual
 * over-count for a long-standing transactor is one statement cycle (the balance
 * outstanding at each endpoint), not twelve, and `reliable` discloses it.
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
 * KNOWN CAVEAT (deliberate, surfaced via `reliable`): the cap uses balances at
 * the window endpoints, so a long-standing transactor still contributes up to
 * one outstanding statement balance. `reliable` is false whenever at least one
 * account was capped — i.e. whenever we detected pay-in-full behaviour and
 * estimated rather than measured — so the UI can caveat the figure. An account
 * whose payments fall below the debt it carries is measured exactly and does
 * NOT clear the flag. Tracking a debt as a loan moves it onto the scheduled
 * path, which is always exact.
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

/**
 * One liability account that no loan points at — a credit card, a line of
 * credit, an untracked personal loan.
 *
 * Grouped PER ACCOUNT (not per currency) because the pay-in-full cap has to be
 * applied per account: a transactor's card and a revolving loan must not offset
 * each other inside one aggregate.
 */
export type UntrackedLiabilityAccount = {
  accountId: number;
  /** Account currency — the denomination of the two balances below. */
  currency: string | null;
  /** Realized payments in the window, split by the TRANSACTION's currency
   *  (a row can be booked in a currency other than the account's). Amounts are
   *  positive: money moving in, reducing the debt. */
  payments: Array<{ currency: string | null; total: number }>;
  /** Owed at `windowStart`, POSITIVE when owed, 0 when in credit. */
  owedAtWindowStart: number;
  /** Owed at `windowEnd`, POSITIVE when owed, 0 when in credit. */
  owedAtWindowEnd: number;
};

export type DebtServiceInput = {
  loans: DebtServiceLoan[];
  /** Liability accounts no loan points at, one entry per account. */
  untrackedLiabilities: UntrackedLiabilityAccount[];
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
  /** Portion from realized payments into untracked liabilities, AFTER the
   *  pay-in-full cap. */
  realized: number;
  /** Loans that contributed at least one month of service in the window. */
  loansCounted: number;
  /** Accounts whose payments exceeded the debt they carried, so the excess was
   *  treated as spending rather than debt service (the pay-in-full case). */
  cappedAccounts: number;
  /** Payment total removed by the cap, in the reporting currency. Surfaced so
   *  the UI can explain the difference rather than silently shrinking DTI. */
  excludedPayInFull: number;
  /** True when nothing in the numerator was ESTIMATED — i.e. no account hit
   *  the pay-in-full cap. Scheduled-only and pay-less-than-you-owe are both
   *  exact and stay reliable. */
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
  const { loans, untrackedLiabilities, windowStart, windowEnd, convert } = input;

  let scheduled = 0;
  let loansCounted = 0;
  for (const loan of loans) {
    const native = scheduledServiceForLoan(loan, windowStart, windowEnd);
    if (native <= 0) continue;
    loansCounted += 1;
    scheduled += convert(native, loan.currency);
  }

  let realized = 0;
  let cappedAccounts = 0;
  let excludedPayInFull = 0;
  for (const account of untrackedLiabilities) {
    let paid = 0;
    for (const row of account.payments) {
      const amount = Number(row.total);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      paid += convert(amount, row.currency);
    }
    if (paid <= 0) continue;

    // The most this account is KNOWN to have owed at a window endpoint. Both
    // balances arrive already flipped to positive-when-owed by the caller;
    // clamp anyway so an account in credit reads 0 rather than negative.
    const carried = Math.max(
      0,
      convert(Math.max(0, account.owedAtWindowStart), account.currency),
      convert(Math.max(0, account.owedAtWindowEnd), account.currency),
    );

    const serviced = Math.min(paid, carried);
    if (serviced < paid) {
      cappedAccounts += 1;
      excludedPayInFull += paid - serviced;
    }
    realized += serviced;
  }

  return {
    total: scheduled + realized,
    scheduled,
    realized,
    loansCounted,
    cappedAccounts,
    excludedPayInFull,
    reliable: cappedAccounts === 0,
  };
}
