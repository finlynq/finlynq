/**
 * Budget v2 building blocks shared by the month engine, the fill action, the
 * API routes and MCP: line keys, account budget roles, month arithmetic.
 * Pure (client-safe). Plan: plan/budget-v2.md.
 */
import { shiftMonth } from "@/lib/reports/category-detail";

export { shiftMonth };

/**
 * A budget line is one category (`c:<id>`) or one EXPENSE category group
 * budgeted as a single line (`g:<group name>`). Income is budgeted per
 * category only.
 */
export type LineKey = `c:${number}` | `g:${string}`;
export type ParsedLineKey = { kind: "category"; categoryId: number } | { kind: "group"; group: string };

export const categoryKey = (id: number): LineKey => `c:${id}`;
export const groupKey = (name: string): LineKey => `g:${name}`;

export function parseLineKey(key: string): ParsedLineKey | null {
  if (key.startsWith("c:")) {
    const id = Number(key.slice(2));
    return Number.isInteger(id) && id > 0 ? { kind: "category", categoryId: id } : null;
  }
  if (key.startsWith("g:")) return { kind: "group", group: key.slice(2) };
  return null;
}

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isMonth = (s: string): boolean => MONTH_RE.test(s);

/** Ascending `YYYY-MM` list from `from` to `to` inclusive (empty when reversed). */
export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to && out.length < 600; m = shiftMonth(m, 1)) out.push(m);
  return out;
}

export function monthStartDate(month: string): string {
  return `${month}-01`;
}

export function monthEndDate(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}

// ─── Account budget roles ───────────────────────────────────────────────────

/**
 * How an account counts in the budget.
 *   categories   — its purchases and income count in their categories
 *   debt_payment — payments into it are one debt-payment line; anything else
 *                  on it (interest, fees) belongs to that line, not to a category
 *   excluded     — nothing on it counts
 */
export const BUDGET_ROLES = ["categories", "debt_payment", "excluded"] as const;
export type BudgetRole = (typeof BUDGET_ROLES)[number];

export const BUDGET_ROLE_LABELS: Record<BudgetRole, string> = {
  categories: "By category",
  debt_payment: "As a debt payment",
  excluded: "Not counted",
};

/** Loans you repay on a schedule. A credit card (revolving) is budgeted by its purchases. */
export const NON_REVOLVING_LOAN_TYPES: ReadonlySet<string> = new Set(["mortgage", "lease", "loan", "student_loan"]);

/** The role an account gets when the user has not chosen one. */
export function automaticBudgetRole(linkedLoanTypes: readonly string[]): BudgetRole {
  return linkedLoanTypes.some((t) => NON_REVOLVING_LOAN_TYPES.has(t)) ? "debt_payment" : "categories";
}

export function isBudgetRole(v: unknown): v is BudgetRole {
  return typeof v === "string" && (BUDGET_ROLES as readonly string[]).includes(v);
}

export function resolveBudgetRole(stored: string | null | undefined, linkedLoanTypes: readonly string[]): BudgetRole {
  return isBudgetRole(stored) ? stored : automaticBudgetRole(linkedLoanTypes);
}
