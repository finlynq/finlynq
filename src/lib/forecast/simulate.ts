/**
 * The simulate stage (plan/forecast-scenarios.md section 7): month by month,
 * where the money goes. Pure.
 *
 * Money rules (section 3), the same as the budget's:
 *  - income lines add to cash, expense lines take from cash;
 *  - a debt payment is the cash flow; the interest inside it accrues on the
 *    loan and is NEVER an expense line (loan numbers come from the loan engine
 *    via inputs.ts, re-anchored to today exactly like the Loans page);
 *  - investment growth is not cash; cards are assumed paid in full each month
 *    (their purchases are already the expense lines), so card balances stay flat;
 *  - when cash would go below zero: leave it negative (and warn) or sell
 *    investments to cover it (`shortfall`).
 * Balances use assets positive and liabilities as positive amounts owed;
 * net worth = cash + investments + other assets − loans − other liabilities.
 */
import type { ScenarioConfig } from "./config";
import type { ForecastInputs, Milestone, SeriesBlock } from "./types";

const round2 = (n: number) => Math.round(n * 100) / 100;
const EPS = 0.01;

export type SimulateOutput = {
  debtLineAmounts: Map<string, number[]>;
  totals: { income: number[]; expense: number[]; debtPayment: number[]; interest: number[]; net: number[]; drawn: number[] };
  opening: Record<keyof SeriesBlock, number>;
  balances: SeriesBlock;
  loans: Array<{ accountId: number; label: string; openingBalance: number; payoffMonth: string | null; interestTotal: number }>;
  milestones: Milestone[];
};

export function openingBalances(inputs: ForecastInputs): Record<keyof SeriesBlock, number> {
  let cash = 0;
  let investments = 0;
  let otherAssets = 0;
  let otherLiabilities = 0;
  for (const a of inputs.accounts) {
    if (a.pool === "cash") cash += a.balance;
    else if (a.pool === "investments") investments += a.balance;
    else if (a.pool === "otherAssets") otherAssets += a.balance;
    else if (a.pool === "otherLiabilities") otherLiabilities += -a.balance; // owed = −balance
  }
  const loans = inputs.loans.reduce((s, l) => s + l.openingBalance, 0);
  return {
    cash: round2(cash),
    investments: round2(investments),
    otherAssets: round2(otherAssets),
    loans: round2(loans),
    otherLiabilities: round2(otherLiabilities),
    netWorth: round2(cash + investments + otherAssets - loans - otherLiabilities),
  };
}

export function simulate(
  inputs: ForecastInputs,
  config: ScenarioConfig,
  months: readonly string[],
  planned: Map<string, Array<number | null>>,
): SimulateOutput {
  const typeOf = new Map(inputs.lines.map((l) => [l.key, l.type]));
  const opening = openingBalances(inputs);
  const n = months.length;
  const series = (): number[] => new Array(n).fill(0);
  const totals = { income: series(), expense: series(), debtPayment: series(), interest: series(), net: series(), drawn: series() };
  const balances: SeriesBlock = {
    cash: series(), investments: series(), otherAssets: series(), loans: series(), otherLiabilities: series(), netWorth: series(),
  };
  const debtLineAmounts = new Map<string, number[]>();
  const loanState = inputs.loans.map((l) => ({
    input: l,
    balance: l.openingBalance,
    payoffMonth: l.openingBalance <= EPS ? null : (null as string | null),
    interestTotal: 0,
    amounts: series(),
  }));

  let cash = opening.cash;
  let investments = opening.investments;
  let otherAssets = opening.otherAssets;
  const invMonthly = Math.pow(1 + config.assumptions.investmentReturnPct / 100, 1 / 12);
  const assetMonthly = Math.pow(1 + config.assumptions.otherAssetGrowthPct / 100, 1 / 12);
  const milestones: Milestone[] = [];
  let cashNegativeSeen = false;
  let depletedSeen = opening.investments <= EPS;
  const hadDebt = loanState.some((s) => s.balance > EPS);
  let debtFreeSeen = !hadDebt;

  for (let i = 0; i < n; i++) {
    const month = months[i];
    let income = 0;
    let expense = 0;
    for (const [key, amounts] of planned) {
      const v = amounts[i];
      if (v == null) continue;
      if (typeOf.get(key) === "income") income += v;
      else expense += v;
    }

    let debtPay = 0;
    let interest = 0;
    for (const s of loanState) {
      const row = s.input.months[month];
      let pay = 0;
      if (row) {
        pay = row.payment;
        interest += row.interest;
        s.interestTotal += row.interest;
        s.balance = row.balance;
      } else if (s.input.fixedPayment != null && s.balance > EPS) {
        pay = Math.min(s.input.fixedPayment, s.balance);
        s.balance -= pay;
      }
      s.amounts[i] = round2(pay);
      debtPay += pay;
      if (s.payoffMonth == null && s.input.openingBalance > EPS && s.balance <= EPS) {
        s.payoffMonth = month;
        milestones.push({ kind: "loan_paid_off", month, label: `${s.input.label} paid off`, ref: `debt:${s.input.accountId}` });
      }
    }

    cash += income - expense - debtPay;
    investments *= invMonthly;
    otherAssets *= assetMonthly;

    let drawn = 0;
    if (cash < 0 && config.shortfall === "draw_investments" && investments > 0) {
      drawn = Math.min(-cash, investments);
      investments -= drawn;
      cash += drawn;
    }

    const loansOwed = loanState.reduce((sum, s) => sum + Math.max(0, s.balance), 0);
    balances.cash[i] = round2(cash);
    balances.investments[i] = round2(investments);
    balances.otherAssets[i] = round2(otherAssets);
    balances.loans[i] = round2(loansOwed);
    balances.otherLiabilities[i] = opening.otherLiabilities;
    balances.netWorth[i] = round2(cash + investments + otherAssets - loansOwed - opening.otherLiabilities);
    totals.income[i] = round2(income);
    totals.expense[i] = round2(expense);
    totals.debtPayment[i] = round2(debtPay);
    totals.interest[i] = round2(interest);
    totals.net[i] = round2(income - expense - debtPay);
    totals.drawn[i] = round2(drawn);

    if (!debtFreeSeen && loansOwed <= EPS) {
      debtFreeSeen = true;
      milestones.push({ kind: "debt_free", month, label: "All loans paid off" });
    }
    if (!cashNegativeSeen && cash < -EPS) {
      cashNegativeSeen = true;
      milestones.push({ kind: "cash_negative", month, label: "Cash goes below zero" });
    }
    if (!depletedSeen && investments <= EPS) {
      depletedSeen = true;
      milestones.push({ kind: "investments_depleted", month, label: "Investments used up" });
    }
  }

  for (const s of loanState) debtLineAmounts.set(`debt:${s.input.accountId}`, s.amounts);

  return {
    debtLineAmounts,
    totals,
    opening,
    balances,
    loans: loanState.map((s) => ({
      accountId: s.input.accountId,
      label: s.input.label,
      openingBalance: round2(s.input.openingBalance),
      payoffMonth: s.payoffMonth,
      interestTotal: round2(s.interestTotal),
    })),
    milestones,
  };
}
