/**
 * Forecast data shapes (plan/forecast-scenarios.md). Pure, client-safe.
 *
 * `ForecastInputs` is the snapshot of real data the server builds once
 * (inputs.ts) and the browser keeps, so the engine can re-run instantly.
 * `ForecastResult` is what one run produces; it is plain JSON, versioned and
 * self-describing (labels, currency, assumptions, data date) so a saved
 * snapshot can be read and compared later (plan section 8a).
 * All money is in `currency` (the display currency).
 */
import type { ForecastAssumptions, LineType } from "./config";

export type ForecastLineDef = {
  /** Budget line key: `cat:<id>`, `grp:<name>`, or `debt:<accountId>`. */
  key: string;
  label: string;
  type: LineType;
  /** Category group, for grouping in the table. */
  group: string;
};

export type BudgetSeries = {
  /** Budget per month ("YYYY-MM" → amount, positive), only months that have one. */
  months: Record<string, number>;
  /** Last month the budget itself covers; months after it may be carried (if the layer allows). */
  carryFrom: string | null;
  /** Amount carried past `carryFrom` (the budget in that month), or null when nothing carries. */
  carryAmount: number | null;
};

export type LoanInput = {
  accountId: number;
  label: string;
  /** Owed today. */
  openingBalance: number;
  balanceSource: "account" | "projection" | "fixed";
  /** Per month from the start month on: payment (cash), interest (not cash), balance after. */
  months: Record<string, { payment: number; interest: number; principal: number; balance: number }>;
  /** Fixed monthly payment for a debt account with no loan schedule (no interest modelled). */
  fixedPayment: number | null;
};

export type PoolAccount = {
  id: number;
  label: string;
  pool: ForecastPool;
  balance: number;
};

export type ForecastPool = "cash" | "investments" | "otherAssets" | "loans" | "otherLiabilities";

export type ForecastInputs = {
  inputsAsOf: string;
  today: string;
  /** First forecast month (next month); opening balances are today's. */
  startMonth: string;
  currency: string;
  /** Longest horizon these inputs cover. */
  maxHorizonMonths: number;
  /** Last month the stored budget horizon reaches (budget rules beyond it are already in `budget`). */
  budgetHorizonEnd: string;
  lines: ForecastLineDef[];
  budget: Record<string, BudgetSeries>;
  loans: LoanInput[];
  accounts: PoolAccount[];
  notes: string[];
  /** Lines left out on purpose, with why (e.g. loan interest the debt payment already covers). */
  leftOut: Array<{ key: string; label: string; reason: string }>;
};

export type TraceStep = { layerId: string; label: string; op: string; before: number | null; after: number | null; detail?: string };

export type ForecastLineResult = {
  key: string;
  label: string;
  type: LineType;
  group: string;
  /** One per month; null = blank (no layer gave it a value). */
  amounts: Array<number | null>;
  total: number;
};

export type Milestone = {
  kind: "loan_paid_off" | "debt_free" | "cash_negative" | "investments_depleted";
  month: string;
  label: string;
  ref?: string;
};

export type ForecastWarning = { code: string; message: string; ref?: string };

export type SeriesBlock = {
  cash: number[];
  investments: number[];
  otherAssets: number[];
  loans: number[];
  otherLiabilities: number[];
  netWorth: number[];
};

export type ForecastResult = {
  resultSchemaVersion: number;
  engineVersion: number;
  computedAt: string;
  inputsAsOf: string;
  currency: string;
  startMonth: string;
  months: string[];
  assumptions: ForecastAssumptions;
  shortfall: "negative" | "draw_investments";
  layers: Array<{ id: string; kind: string; label: string; enabled: boolean }>;
  lines: ForecastLineResult[];
  totals: {
    income: number[];
    expense: number[];
    debtPayment: number[];
    /** Interest inside loan payments (not a cash flow; shown for information). */
    interest: number[];
    /** income − expense − debt payments. */
    net: number[];
    /** Sold from investments to cover cash (shortfall = draw_investments). */
    drawn: number[];
  };
  /** Today's balances (the starting point). */
  opening: Record<keyof SeriesBlock, number>;
  balances: SeriesBlock;
  loans: Array<{ accountId: number; label: string; openingBalance: number; payoffMonth: string | null; interestTotal: number }>;
  milestones: Milestone[];
  warnings: ForecastWarning[];
  /** Divide a month's money by this to show it in today's money. */
  deflator: number[];
  /** Lines with no value in any month (e.g. no budget). */
  blankLines: Array<{ key: string; label: string; type: LineType }>;
};
