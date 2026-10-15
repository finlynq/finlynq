// What the Loans page shows for one loan, shared by its card and list views so
// the two can never disagree. Pure and client-safe.
//
// The list view exists because of in-app feedback (2026-10-15): with 17 loans,
// the cards fit about three to a screen.

export type LoansView = "cards" | "list";

/** localStorage key for the chosen view. A per-browser convenience only. */
export const LOANS_VIEW_STORAGE_KEY = "pf-loans-view";

/** Anything other than "list" (absent, blocked storage, junk) means cards. */
export function parseLoansView(raw: string | null | undefined): LoansView {
  return raw === "list" ? "list" : "cards";
}

/**
 * Share of the principal paid off, 0 to 100.
 *
 * `remainingBalance` is null for a loan the server could not schedule; that
 * loan has paid nothing we can measure, so it reads 0 (the old inline formula
 * read it as 100% paid, since `principal - null` is `principal`).
 */
export function loanPaidPct(loan: { principal: number; remainingBalance: number | null }): number {
  if (loan.remainingBalance == null || !(loan.principal > 0)) return 0;
  const pct = ((loan.principal - loan.remainingBalance) / loan.principal) * 100;
  return Math.max(0, Math.min(pct, 100));
}

/**
 * The rate worth showing. For a loan priced by its yearly rate that is the
 * rate; for a fixed-amount or total-interest loan it is the effective yearly
 * rate on the balance owed, since the stored rate does not produce its interest.
 */
export function loanShownRate(loan: {
  annualRate: number;
  interestMethod?: string | null;
  effectiveAnnualRate?: number | null;
}): { rate: number; effective: boolean } {
  if ((loan.interestMethod ?? "rate") === "rate") return { rate: loan.annualRate, effective: false };
  return { rate: loan.effectiveAnnualRate ?? loan.annualRate, effective: true };
}

/** Short "per period" suffix for a payment in the list view. */
export const PAYMENT_FREQUENCY_SHORT: Record<string, string> = {
  weekly: "/wk",
  biweekly: "/2 wk",
  semi_monthly: "2×/mo",
  monthly: "/mo",
  quarterly: "/qtr",
  annual: "/yr",
};

const LOAN_TYPE_LABELS: Record<string, string> = {
  mortgage: "Mortgage",
  lease: "Lease",
  loan: "Loan",
  student_loan: "Student loan",
  credit_card: "Credit card",
};

/** "student_loan" → "Student loan"; unknown types are tidied, not hidden. */
export function loanTypeLabel(type: string | null | undefined): string {
  if (!type) return "Loan";
  return LOAN_TYPE_LABELS[type] ?? type.charAt(0).toUpperCase() + type.slice(1).replace(/_/g, " ");
}
