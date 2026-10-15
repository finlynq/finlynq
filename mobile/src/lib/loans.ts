// Loans — pure helpers for the Loans screen. Mirrors the web rule in
// pf-app `src/lib/loan-status.ts`; keep the two in sync.

import type {
  LoanFormData,
  LoanInterestMethod,
  LoanScheduleRow,
  LoanSummary,
} from "../../../shared/types";
import { isValidIsoDate } from "./subscriptions";

// Cards, or one compact row per loan (in-app feedback 2026-10-15: someone with
// 17 loans could see about three at a time). Mirrors the web's Cards / List
// switch in pf-app `src/lib/loans/list-view.ts`; keep the two in sync.
export type LoansView = "cards" | "list";
export const LOANS_VIEW_KEY = "pf-loans-view";

/** Anything other than "list" (nothing stored, junk) means cards. */
export function parseLoansView(raw: string | null | undefined): LoansView {
  return raw === "list" ? "list" : "cards";
}

/**
 * Short "per period" suffix for a payment in the compact list, written straight
 * after the amount (hence the space before "2×/mo", which the web sets apart
 * with a margin instead).
 */
export const PAYMENT_FREQUENCY_SHORT: Record<string, string> = {
  weekly: "/wk",
  biweekly: "/2 wk",
  semi_monthly: " 2×/mo",
  monthly: "/mo",
  quarterly: "/qtr",
  annual: "/yr",
};

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

/**
 * The rate to show for a loan. A fixed-amount or total-interest loan is not
 * driven by `annualRate`, so its comparable yearly rate is shown instead and
 * labelled as such; a manual schedule has no single rate.
 */
export function loanRateLabel(
  loan: Pick<LoanSummary, "annualRate" | "interestMethod" | "effectiveAnnualRate" | "scheduleMode">,
): string {
  if (loan.scheduleMode === "manual") return "Manual schedule";
  if ((loan.interestMethod ?? "rate") !== "rate" && loan.effectiveAnnualRate != null) {
    return `${loan.effectiveAnnualRate}% effective`;
  }
  return `${loan.annualRate}%`;
}

/**
 * A schedule split at `today` ("YYYY-MM-DD"): payments already due, and those
 * still to come. A payment due today counts as still to come, so the first
 * upcoming row is the next one to make.
 */
export function splitSchedule<T extends Pick<LoanScheduleRow, "date">>(
  rows: readonly T[],
  today: string,
): { past: T[]; upcoming: T[] } {
  const past: T[] = [];
  const upcoming: T[] = [];
  for (const r of rows) (r.date < today ? past : upcoming).push(r);
  return { past, upcoming };
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

// ─── The loan form ────────────────────────────────────────────────────────
// One form state and one payload builder for create and edit, mirroring the
// web's Loans dialog (a second shape is how the two modes drift apart).

export const LOAN_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "mortgage", label: "Mortgage" },
  { value: "loan", label: "Loan" },
  { value: "lease", label: "Lease" },
  { value: "student_loan", label: "Student loan" },
  { value: "credit_card", label: "Credit card" },
];

export const LOAN_FREQUENCY_OPTIONS: { value: string; label: string }[] = [
  "weekly",
  "biweekly",
  "semi_monthly",
  "monthly",
  "quarterly",
  "annual",
].map((value) => ({ value, label: LOAN_FREQUENCY_LABEL[value] }));

/** How a loan's interest is worked out. Same three choices as the web form. */
export const LOAN_INTEREST_OPTIONS: { value: LoanInterestMethod; label: string; field: string; hint: string }[] = [
  {
    value: "rate",
    label: "Yearly rate",
    field: "YEARLY RATE (%)",
    hint: "Interest is charged on what is still owed, at this rate.",
  },
  {
    value: "flat",
    label: "Fixed amount each payment",
    field: "INTEREST EACH PAYMENT",
    hint:
      "Every payment carries this same interest, the way such loans are advertised. Interest really accrues on " +
      "what is still owed, so the loan also shows the yearly rate this works out to.",
  },
  {
    value: "total",
    label: "Total for the whole loan",
    field: "TOTAL INTEREST",
    hint:
      "The whole loan's interest, spread the standard way: more in the early payments, less at the end. The " +
      "loan also shows the yearly rate this works out to.",
  },
];

export interface LoanFormState {
  name: string;
  type: string;
  currency: string;
  principal: string;
  interestMethod: LoanInterestMethod;
  annualRate: string;
  interestAmount: string;
  termMonths: string;
  paymentAmount: string;
  paymentFrequency: string;
  extraPayment: string;
  residualValue: string;
  startDate: string;
  accountId: number | null;
}

const text = (n: number | null | undefined) => (n == null ? "" : String(n));

/**
 * The form for a new loan, or for editing `loan`. Edit seeds from the loan's
 * own figures in its own currency, never the display-currency companions:
 * saving those back would rewrite the loan in another currency.
 */
export function loanFormInit(loan: LoanSummary | null, today: string): LoanFormState {
  if (!loan) {
    return {
      name: "",
      type: "loan",
      currency: "",
      principal: "",
      interestMethod: "rate",
      annualRate: "",
      interestAmount: "",
      termMonths: "",
      paymentAmount: "",
      paymentFrequency: "monthly",
      extraPayment: "",
      residualValue: "",
      startDate: today,
      accountId: null,
    };
  }
  return {
    name: loan.name ?? "",
    type: loan.type || "loan",
    currency: loan.currency ?? "",
    principal: text(loan.principal),
    interestMethod: loan.interestMethod ?? "rate",
    annualRate: text(loan.annualRate),
    interestAmount: text(loan.interestAmount),
    termMonths: text(loan.termMonths),
    paymentAmount: text(loan.paymentAmount),
    paymentFrequency: LOAN_FREQUENCY_LABEL[loan.paymentFrequency] ? loan.paymentFrequency : "monthly",
    extraPayment: loan.extraPayment ? String(loan.extraPayment) : "",
    residualValue: text(loan.residualValue),
    startDate: loan.startDate ?? today,
    accountId: loan.accountId ?? null,
  };
}

const num = (s: string) => parseFloat(s.trim().replace(",", "."));

/**
 * Check the form and build the request body, or say what is wrong. The server
 * checks again (and refuses a loan whose payment never pays it off); this
 * catches what can be said without a round trip.
 */
export function buildLoanPayload(
  f: LoanFormState,
): { ok: true; body: LoanFormData } | { ok: false; error: string } {
  const name = f.name.trim();
  if (!name) return { ok: false, error: "Please enter a name" };

  const principal = num(f.principal);
  if (!Number.isFinite(principal) || principal <= 0) {
    return { ok: false, error: "Please enter the amount borrowed, greater than 0" };
  }

  const currency = f.currency.trim().toUpperCase();
  if (!/^[A-Z]{3,4}$/.test(currency)) return { ok: false, error: "Please choose a currency" };

  let annualRate = num(f.annualRate);
  let interestAmount: number | null = null;
  if (f.interestMethod === "rate") {
    if (!Number.isFinite(annualRate) || annualRate < 0) {
      return { ok: false, error: "Please enter the yearly rate, 0 or more" };
    }
  } else {
    interestAmount = num(f.interestAmount);
    if (!Number.isFinite(interestAmount) || interestAmount < 0) {
      return {
        ok: false,
        error:
          f.interestMethod === "flat"
            ? "Please enter the interest in each payment, 0 or more"
            : "Please enter the loan's total interest, 0 or more",
      };
    }
    // The rate is not what produces the interest here; keep what was there, or 0.
    if (!Number.isFinite(annualRate) || annualRate < 0) annualRate = 0;
  }

  const termText = f.termMonths.trim();
  const payText = f.paymentAmount.trim();
  if (!termText && !payText) return { ok: false, error: "Enter a term in months, or the payment amount" };
  let termMonths: number | null = null;
  if (termText) {
    termMonths = Number(termText);
    if (!Number.isInteger(termMonths) || termMonths <= 0) {
      return { ok: false, error: "The term must be a whole number of months" };
    }
  }
  let paymentAmount: number | null = null;
  if (payText) {
    paymentAmount = num(payText);
    if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
      return { ok: false, error: "The payment must be greater than 0" };
    }
  }

  const startDate = f.startDate.trim();
  if (!isValidIsoDate(startDate)) return { ok: false, error: "The start date must be a date like 2026-10-15" };

  let extraPayment = 0;
  if (f.extraPayment.trim()) {
    extraPayment = num(f.extraPayment);
    if (!Number.isFinite(extraPayment) || extraPayment < 0) {
      return { ok: false, error: "The extra payment must be 0 or more" };
    }
  }

  // A balance left at the end of the term only exists for a lease.
  let residualValue: number | null = null;
  if (f.type === "lease" && f.residualValue.trim()) {
    residualValue = num(f.residualValue);
    if (!Number.isFinite(residualValue) || residualValue < 0) {
      return { ok: false, error: "The buyout must be 0 or more" };
    }
    if (residualValue >= principal) return { ok: false, error: "The buyout must be less than the amount borrowed" };
  }

  return {
    ok: true,
    body: {
      name,
      type: f.type,
      principal,
      currency,
      annualRate,
      interestMethod: f.interestMethod,
      interestAmount,
      termMonths,
      startDate,
      paymentAmount,
      paymentFrequency: f.paymentFrequency,
      extraPayment,
      residualValue,
      accountId: f.accountId,
    },
  };
}
