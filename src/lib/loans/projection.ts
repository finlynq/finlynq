/**
 * Where a loan stands TODAY and how it pays down from here: one rule, used by
 * the Loans page (`GET /api/loans`) and the forecast (src/lib/forecast), so a
 * payoff date can never differ between the two.
 *
 * FINLYNQ-136: when the loan's linked account has ledger activity, its balance
 * is the truth (|sum|, liability accounts carry negative balances) and the
 * payoff is re-projected from today with the loan's payment and rate. A manual
 * schedule keeps its own dates (re-projecting with a calculated payment would
 * overwrite what the user typed). Without account activity, the original
 * schedule is the projection.
 *
 * Pure: the caller builds the schedule (`buildLoanSchedule` with
 * `loanScheduleExtras(row)`) and passes the account balance.
 */
import { buildLoanSchedule, type AmortizationRow, type LoanSummary } from "@/lib/loan-calculator";

export type LoanProjectionInput = {
  principal: number;
  annualRate: number;
  paymentAmount: number | null;
  paymentFrequency: string | null;
  extraPayment: number | null;
  residualValue: number | null;
};

export type LoanProjection = {
  /** What is owed today, in the loan's currency. */
  remainingBalance: number;
  balanceSource: "account" | "projection";
  payoffDate: string;
  periodsRemaining: number;
  /** Schedule rows dated AFTER today, in the loan's currency. */
  upcoming: AmortizationRow[];
  principalPaid: number;
  interestPaid: number;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export function projectLoanFromToday(
  loan: LoanProjectionInput,
  summary: LoanSummary,
  account: { balance: number; txCount: number } | undefined,
  today: string,
): LoanProjection {
  const paid = summary.schedule.filter((r) => r.date <= today);
  const principalPaid = paid.reduce((s, r) => s + r.principal, 0);
  const interestPaid = paid.reduce((s, r) => s + r.interest, 0);

  let remainingBalance = Math.max(loan.principal - principalPaid, 0);
  let balanceSource: LoanProjection["balanceSource"] = "projection";
  let payoffDate = summary.payoffDate;
  let periodsRemaining = summary.schedule.length - paid.length;
  let upcoming = summary.schedule.filter((r) => r.date > today);

  if (account && account.txCount > 0) {
    remainingBalance = round2(Math.abs(account.balance));
    balanceSource = "account";
    const residual = loan.residualValue ?? 0;
    if (remainingBalance <= residual + 0.01) {
      payoffDate = today;
      periodsRemaining = 0;
      upcoming = [];
    } else if (summary.scheduleMode === "manual") {
      // The user supplied the dates themselves; keep them.
    } else {
      try {
        const anchored = buildLoanSchedule({
          principal: remainingBalance,
          annualRate: loan.annualRate,
          startDate: today,
          paymentAmount: loan.paymentAmount ?? summary.paymentPerPeriod,
          paymentFrequency: loan.paymentFrequency,
          extraPayment: loan.extraPayment ?? 0,
          residualValue: loan.residualValue,
        });
        payoffDate = anchored.payoffDate;
        periodsRemaining = anchored.schedule.length;
        upcoming = anchored.schedule.filter((r) => r.date > today);
      } catch {
        // Payment doesn't amortize the actual balance — keep projection dates.
      }
    }
  }

  return { remainingBalance, balanceSource, payoffDate, periodsRemaining, upcoming, principalPaid, interestPaid };
}
