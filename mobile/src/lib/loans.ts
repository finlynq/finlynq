// Loans — pure helpers for the Loans screen. Mirrors the web rule in
// pf-app `src/lib/loan-status.ts`; keep the two in sync.

import type { LoanSummary } from "../../../shared/types";

export const LOAN_FREQUENCY_LABEL: Record<string, string> = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  semi_monthly: "Twice a month",
  monthly: "Monthly",
  quarterly: "Quarterly",
  annual: "Yearly",
};

const LOAN_TYPE_LABEL: Record<string, string> = {
  mortgage: "Mortgage",
  lease: "Lease",
  loan: "Loan",
  auto: "Auto loan",
  student: "Student loan",
  student_loan: "Student loan",
  personal: "Personal loan",
  credit_card: "Credit card",
};

export function loanTypeLabel(type: string | null | undefined): string {
  if (!type) return "Loan";
  return LOAN_TYPE_LABEL[type] ?? type.charAt(0).toUpperCase() + type.slice(1).replace(/_/g, " ");
}

/**
 * Paid off: nothing left to pay (balance rounds to zero or no periods remain).
 *
 * The server sends `remainingBalance` / `periodsRemaining` as null for a loan
 * it could not schedule. That is NOT paid off — it is the loan most in need of
 * attention — and `null <= 0.5` is true in JS, so the nulls are checked first.
 *
 * A MANUAL schedule is only as long as the rows the user supplied, so "no
 * periods remain" does not mean paid off there; only the balance decides.
 */
export function isLoanCompleted(
  loan: Pick<LoanSummary, "remainingBalance" | "periodsRemaining" | "scheduleMode">,
): boolean {
  if (loan.remainingBalance == null || loan.periodsRemaining == null) return false;
  if (loan.remainingBalance <= 0.5) return true;
  return loan.scheduleMode !== "manual" && loan.periodsRemaining <= 0;
}

/** Active loans first-class, paid-off ones apart so they can stay hidden. */
export function splitLoans(loans: LoanSummary[]): { active: LoanSummary[]; completed: LoanSummary[] } {
  const active: LoanSummary[] = [];
  const completed: LoanSummary[] = [];
  for (const l of loans) (isLoanCompleted(l) ? completed : active).push(l);
  return { active, completed };
}

/** Share of the original amount already paid down, 0 to 100. */
export function loanPaidPct(loan: Pick<LoanSummary, "principal" | "remainingBalance">): number {
  if (loan.remainingBalance == null || !(loan.principal > 0)) return 0;
  const pct = ((loan.principal - loan.remainingBalance) / loan.principal) * 100;
  return Math.max(0, Math.min(pct, 100));
}

/**
 * Totals across loans. Only the server's display-currency companions are
 * summed: the native amounts are in each loan's own currency and adding those
 * up under one symbol reports a mixed-currency book wrongly.
 */
export function loanTotals(loans: LoanSummary[]): { owed: number; monthly: number } {
  let owed = 0;
  let monthly = 0;
  for (const l of loans) {
    owed += l.remainingBalanceDisplay ?? 0;
    monthly += l.monthlyEquivalentPaymentDisplay ?? 0;
  }
  return { owed, monthly };
}
