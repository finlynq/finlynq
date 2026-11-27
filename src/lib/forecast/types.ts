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
  /**
   * What the engine needs to re-amortize the loan from any month (extra
   * payments, refinancing, a debt strategy): yearly rate and the monthly
   * equivalent of its payment, in the display currency. `reamortizable` is
   * false for a hand-typed schedule, a flat/total interest method, or an
   * account with several loans: those keep their schedule rows.
   */
  terms: { annualRatePct: number; monthlyPayment: number; residual: number; reamortizable: boolean } | null;
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
  /** For retirement: ages are this month's year minus it. Null = not given. */
  birthYear?: number | null;
  currency: string;
  /** Longest horizon these inputs cover. */
  maxHorizonMonths: number;
  /** Last month the stored budget horizon reaches (budget rules beyond it are already in `budget`). */
  budgetHorizonEnd: string;
  lines: ForecastLineDef[];
  budget: Record<string, BudgetSeries>;
  /** Budget per line for the CURRENT month (the month before the forecast). Only used to explain blank lines (GH #463). */
  currentMonthBudget?: Record<string, number>;
  loans: LoanInput[];
  accounts: PoolAccount[];
  /** Complete months before the forecast (oldest first) that `history` / `pastBudget` cover. */
  historyMonths: string[];
  /** Actual amount per line per past month (spending and income positive, refunds net), budget attribution rules. */
  history: Record<string, Record<string, number>>;
  /** Budget per line per past month (for budget realism). */
  pastBudget: Record<string, Record<string, number>>;
  /** Subscriptions + recurring payments per line per forecast month. */
  scheduled: Record<string, Record<string, number>>;
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
  kind: "loan_paid_off" | "debt_free" | "cash_negative" | "investments_depleted" | "retired" | "money_runs_out";
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
    /** Moved from cash into investments by events (negative = taken out). */
    toInvestments: number[];
    /** Cash spent buying assets (a home's down payment). */
    purchases: number[];
    /** Loan money received in cash (a new loan with cashIn). */
    borrowed: number[];
    /** Paid from investments to cash by a retirement withdrawal strategy. */
    withdrawn: number[];
  };
  /** Today's balances (the starting point). */
  opening: Record<keyof SeriesBlock, number>;
  balances: SeriesBlock;
  loans: Array<{ key: string; accountId: number | null; label: string; openingBalance: number; payoffMonth: string | null; interestTotal: number; isNew: boolean }>;
  events: Array<{ id: string; kind: string; label: string; month: string; enabled: boolean }>;
  birthYear: number | null;
  /** Set when the scenario has a retire event inside the horizon. */
  retirement: {
    month: string;
    age: number | null;
    investmentsAtRetirement: number;
    netWorthAtRetirement: number;
    /** First month money runs out after retiring (cash below zero with nothing left to sell); null = not within the forecast. */
    runsOutMonth: string | null;
    runsOutAge: number | null;
    /** Last month of the forecast and the age then, so "lasts past N" can be said. */
    horizonEndMonth: string;
    horizonEndAge: number | null;
  } | null;
  milestones: Milestone[];
  warnings: ForecastWarning[];
  /** Divide a month's money by this to show it in today's money. */
  deflator: number[];
  /** Lines with no value in any month (e.g. no budget). */
  blankLines: Array<{ key: string; label: string; type: LineType }>;
};
