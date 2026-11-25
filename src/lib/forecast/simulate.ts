/**
 * The simulate stage (plan/forecast-scenarios.md section 7): month by month,
 * where the money goes. Pure.
 *
 * Money rules (section 3), the same as the budget's:
 *  - income lines add to cash, expense lines take from cash;
 *  - a debt payment is the cash flow; the interest inside it accrues on the
 *    loan and is NEVER an expense line;
 *  - investment growth is not cash; cards are assumed paid in full each month
 *    (their purchases are already the expense lines), so card balances stay flat;
 *  - moving money between cash and investments, a down payment (cash → the
 *    home), or borrowing changes balances, never income or spending;
 *  - when cash would go below zero: leave it negative (and warn) or sell
 *    investments to cover it (`shortfall`);
 *  - after a retire event, a withdrawal strategy moves money from investments
 *    to cash (a transfer, never income): cover the shortfall only, a yearly %
 *    of investments at retirement (the "4% rule", growing with inflation), or
 *    a fixed monthly amount. Money "runs out" in the first month after
 *    retiring when cash is below zero and nothing is left to sell.
 *
 * Loans: each loan follows its schedule rows (from the loan engine, re-anchored
 * like the Loans page) until the first month a scenario change touches it (an
 * extra payment, a refinance, a debt strategy). From then on it is amortized
 * month by month here: interest = balance × rate / 12, payment = its monthly
 * payment (+ extras), principal = payment − interest. A loan whose schedule
 * can't be re-amortized honestly (hand-typed, flat/total interest, several
 * loans on one account) keeps its rows and the change is skipped with a warning.
 *
 * Debt strategy, the same rules as `calculateDebtPayoff` (get_debt_payoff_plan):
 * a fixed order set at the start (avalanche = highest rate first, snowball =
 * smallest balance first), the extra goes to the first unpaid loan, and a
 * paid-off loan's payment rolls into the extra. One deliberate difference:
 * money left over in a loan's final month goes to the next loan in that same
 * month instead of being lost, so payoffs are the same month or earlier.
 *
 * Balances use assets positive and liabilities as positive amounts owed;
 * net worth = cash + investments + other assets − loans − other liabilities.
 */
import type { ScenarioConfig } from "./config";
import { annuityPayment, type ExpandedEvents } from "./events";
import type { ForecastInputs, ForecastResult, Milestone, SeriesBlock } from "./types";

const round2 = (n: number) => Math.round(n * 100) / 100;
const EPS = 0.01;

export type SimulateOutput = {
  debtLineAmounts: Map<string, number[]>;
  debtLines: Array<{ key: string; label: string }>;
  totals: ForecastResult["totals"];
  opening: Record<keyof SeriesBlock, number>;
  balances: SeriesBlock;
  loans: ForecastResult["loans"];
  milestones: Milestone[];
  warnings: Array<{ code: string; message: string; ref?: string }>;
  retirement: { idx: number; investmentsAtRetirement: number; netWorthAtRetirement: number; runsOutMonth: string | null } | null;
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

type LoanState = {
  key: string;
  accountId: number | null;
  label: string;
  isNew: boolean;
  openingBalance: number;
  balance: number;
  rows: ForecastInputs["loans"][number]["months"] | null;
  fixedPayment: number | null;
  annualRatePct: number;
  monthlyPayment: number;
  residual: number;
  reamortizable: boolean;
  /** Month index from which this loan is amortized here instead of following its rows. */
  amortizeFrom: number;
  /** New loans: month index the loan starts (balance before it is 0). */
  startIdx: number;
  cashIn: boolean;
  payoffMonth: string | null;
  interestTotal: number;
  amounts: number[];
  active: boolean;
};

function emptyExpanded(n: number): ExpandedEvents {
  return {
    lines: [], amounts: new Map(), layers: [],
    toInvestments: new Array(n).fill(0), purchases: new Array(n).fill(0), assetAdds: new Array(n).fill(0),
    loanPlan: { extras: new Map(), refinances: new Map(), newLoans: [], strategy: null },
    retirement: null,
    warnings: [],
  };
}

export function simulate(
  inputs: ForecastInputs,
  config: ScenarioConfig,
  months: readonly string[],
  planned: Map<string, Array<number | null>>,
  typeOf: Map<string, string>,
  expanded: ExpandedEvents = emptyExpanded(months.length),
): SimulateOutput {
  const opening = openingBalances(inputs);
  const n = months.length;
  const series = (): number[] => new Array(n).fill(0);
  const totals: ForecastResult["totals"] = {
    income: series(), expense: series(), debtPayment: series(), interest: series(), net: series(), drawn: series(),
    toInvestments: series(), purchases: series(), borrowed: series(), withdrawn: series(),
  };
  const balances: SeriesBlock = {
    cash: series(), investments: series(), otherAssets: series(), loans: series(), otherLiabilities: series(), netWorth: series(),
  };
  const warnings: SimulateOutput["warnings"] = [...expanded.warnings];
  const plan = expanded.loanPlan;

  // ── Loan states ──────────────────────────────────────────────────────
  const loans: LoanState[] = inputs.loans.map((l) => ({
    key: `debt:${l.accountId}`,
    accountId: l.accountId,
    label: l.label,
    isNew: false,
    openingBalance: l.openingBalance,
    balance: l.openingBalance,
    rows: l.months,
    fixedPayment: l.fixedPayment,
    annualRatePct: l.terms?.annualRatePct ?? 0,
    monthlyPayment: l.terms?.monthlyPayment ?? l.fixedPayment ?? 0,
    residual: l.terms?.residual ?? 0,
    reamortizable: l.terms?.reamortizable ?? false,
    amortizeFrom: Number.POSITIVE_INFINITY,
    startIdx: 0,
    cashIn: false,
    payoffMonth: null,
    interestTotal: 0,
    amounts: series(),
    active: true,
  }));
  for (const nl of plan.newLoans) {
    loans.push({
      key: nl.key, accountId: null, label: nl.label, isNew: true, openingBalance: 0, balance: 0, rows: null, fixedPayment: null,
      annualRatePct: nl.annualRatePct, monthlyPayment: round2(annuityPayment(nl.principal, nl.annualRatePct, nl.termMonths)),
      residual: 0, reamortizable: true, amortizeFrom: nl.startIdx + 1, startIdx: nl.startIdx, cashIn: nl.cashIn,
      payoffMonth: null, interestTotal: 0, amounts: series(), active: false,
    });
  }
  const byKey = new Map(loans.map((l) => [l.key, l]));
  const principalOf = new Map(plan.newLoans.map((nl) => [nl.key, nl.principal]));

  // When does each existing loan switch to amortizing here?
  const switchAt = (l: LoanState, idx: number, why: string) => {
    if (!l.reamortizable) {
      warnings.push({ code: "loan_not_reamortizable", message: `${l.label}: ${why} is skipped, because its schedule is typed by hand, uses a flat or total interest amount, or the account has several loans.`, ref: l.key });
      return false;
    }
    l.amortizeFrom = Math.min(l.amortizeFrom, idx);
    return true;
  };
  for (const [key, arr] of plan.extras) {
    const l = byKey.get(key);
    const first = arr.findIndex((v) => v > 0);
    if (l && first >= 0 && !l.isNew && !switchAt(l, first, "the extra payment")) plan.extras.delete(key);
  }
  const refis = new Map<string, { idx: number; annualRatePct: number; termMonths: number }>();
  for (const [key, r] of plan.refinances) {
    const l = byKey.get(key);
    if (!l) continue;
    if (l.isNew || switchAt(l, r.idx, "the refinance")) refis.set(key, r);
  }
  // Strategy: participating loans, fixed order at the start.
  let strategyOrder: LoanState[] = [];
  const strat = plan.strategy;
  if (strat) {
    const participants = loans.filter((l) => {
      if (l.isNew) return true;
      if (l.balance <= EPS && !(l.rows && Object.keys(l.rows).length)) return false;
      return switchAt(l, strat.startIdx, "the debt strategy") || false;
    });
    strategyOrder = participants; // sorted once balances at the start are known (below)
  }

  // ── Month loop ───────────────────────────────────────────────────────
  let cash = opening.cash;
  let investments = opening.investments;
  let otherAssets = opening.otherAssets;
  const invMonthly = Math.pow(1 + config.assumptions.investmentReturnPct / 100, 1 / 12);
  const assetMonthly = Math.pow(1 + config.assumptions.otherAssetGrowthPct / 100, 1 / 12);
  const milestones: Milestone[] = [];
  let cashNegativeSeen = false;
  let depletedSeen = opening.investments <= EPS;
  let debtFreeSeen = !loans.some((l) => l.balance > EPS) && plan.newLoans.length === 0;
  let freedPool = 0;
  let orderFixed = false;
  const ret = expanded.retirement;
  let retireState: SimulateOutput["retirement"] = null;
  let fixedPctAnnual = 0;
  let shortWarned = false;
  const inflMonthly = Math.pow(1 + config.assumptions.inflationPct / 100, 1 / 12);

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

    // New loans start this month.
    let borrowed = 0;
    for (const l of loans) {
      if (!l.isNew || l.startIdx !== i) continue;
      l.active = true;
      l.balance = principalOf.get(l.key) ?? 0;
      l.openingBalance = l.balance;
      if (l.cashIn) borrowed += l.balance;
    }
    // Refinances: new payment from the balance at the start of the month.
    for (const [key, r] of refis) {
      if (r.idx !== i) continue;
      const l = byKey.get(key)!;
      l.annualRatePct = r.annualRatePct;
      l.monthlyPayment = round2(annuityPayment(l.balance, r.annualRatePct, r.termMonths));
      l.residual = 0;
    }
    // Strategy order is fixed at its first month, from the balances then.
    if (strat && !orderFixed && i >= strat.startIdx) {
      strategyOrder = [...strategyOrder].sort((a, b) =>
        strat.method === "avalanche" ? b.annualRatePct - a.annualRatePct : a.balance - b.balance,
      );
      orderFixed = true;
    }

    let debtPay = 0;
    let interest = 0;
    const room = new Map<string, number>(); // what each amortized loan can still take this month
    for (const l of loans) {
      if (!l.active) continue;
      let pay = 0;
      if (i < l.amortizeFrom) {
        const row = l.rows?.[month];
        if (row) {
          pay = row.payment;
          interest += row.interest;
          l.interestTotal += row.interest;
          l.balance = row.balance;
        } else if (l.fixedPayment != null && l.balance > EPS) {
          pay = Math.min(l.fixedPayment, l.balance);
          l.balance -= pay;
        }
      } else if (l.balance > EPS) {
        const int = (l.balance * l.annualRatePct) / 100 / 12;
        const owedNow = l.balance + int;
        pay = Math.min(owedNow - Math.min(l.residual, l.balance), l.monthlyPayment);
        if (pay < 0) pay = 0;
        const extra = plan.extras.get(l.key)?.[i] ?? 0;
        const extraPaid = Math.min(extra, Math.max(0, owedNow - pay));
        pay += extraPaid;
        interest += int;
        l.interestTotal += int;
        l.balance = owedNow - pay;
        room.set(l.key, Math.max(0, l.balance));
      }
      l.amounts[i] = round2(pay);
      debtPay += pay;
    }

    // Debt strategy: the extra + freed payments, in order, leftovers to the next.
    if (strat && i >= strat.startIdx) {
      let pool = strat.extraPerMonth + freedPool;
      for (const l of strategyOrder) {
        if (pool <= EPS) break;
        if (!l.active || l.balance <= EPS || i < l.amortizeFrom) continue;
        const take = Math.min(pool, room.get(l.key) ?? l.balance);
        if (take <= 0) continue;
        l.balance -= take;
        l.amounts[i] = round2(l.amounts[i] + take);
        debtPay += take;
        pool -= take;
      }
    }

    for (const l of loans) {
      if (!l.active) continue;
      if (l.payoffMonth == null && l.openingBalance > EPS && l.balance <= EPS) {
        l.payoffMonth = month;
        milestones.push({ kind: "loan_paid_off", month, label: `${l.label} paid off`, ref: l.key });
        if (strat && i >= strat.startIdx && strategyOrder.includes(l)) freedPool += l.monthlyPayment;
      }
    }

    if (ret && i === ret.idx) {
      // What there is on the day of retiring (end of the month before).
      const inv0 = i === 0 ? opening.investments : balances.investments[i - 1];
      const nw0 = i === 0 ? opening.netWorth : balances.netWorth[i - 1];
      retireState = { idx: i, investmentsAtRetirement: round2(inv0), netWorthAtRetirement: round2(nw0), runsOutMonth: null };
      if (ret.withdrawal.method === "fixed_pct") fixedPctAnnual = (inv0 * ret.withdrawal.pct) / 100;
    }

    const toInv = expanded.toInvestments[i];
    const purchase = expanded.purchases[i];
    cash += income - expense - debtPay - purchase + borrowed;
    investments *= invMonthly;
    otherAssets = otherAssets * assetMonthly + expanded.assetAdds[i];
    let moved = toInv;
    if (moved < 0) moved = -Math.min(-moved, Math.max(0, investments)); // can't take out more than is there
    cash -= moved;
    investments += moved;

    // Retirement withdrawals: investments → cash (a transfer, not income).
    let withdrawn = 0;
    if (ret && i >= ret.idx) {
      const w = ret.withdrawal;
      const grow = (on: boolean) => (on ? Math.pow(inflMonthly, i - ret.idx) : 1);
      let want = 0;
      if (w.method === "fixed_pct") want = (fixedPctAnnual / 12) * grow(w.growWithInflation);
      else if (w.method === "fixed_amount") want = w.amount * grow(w.growWithInflation);
      else if (cash < 0) want = -cash;
      withdrawn = Math.max(0, Math.min(want, investments));
      investments -= withdrawn;
      cash += withdrawn;
      if (w.method !== "cover_shortfall" && !shortWarned && cash < -EPS && investments > 1) {
        shortWarned = true;
        warnings.push({ code: "withdrawals_short", message: `From ${month}, the retirement withdrawals don't cover spending, so cash goes below zero while investments are left. Raise the withdrawal or choose "Sell only what's needed".` });
      }
    }

    let drawn = 0;
    if (cash < 0 && config.shortfall === "draw_investments" && investments > 0) {
      drawn = Math.min(-cash, investments);
      investments -= drawn;
      cash += drawn;
    }

    const loansOwed = loans.reduce((sum, l) => sum + (l.active ? Math.max(0, l.balance) : 0), 0);
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
    totals.toInvestments[i] = round2(moved);
    totals.purchases[i] = round2(purchase);
    totals.borrowed[i] = round2(borrowed);
    totals.withdrawn[i] = round2(withdrawn);
    if (retireState && retireState.runsOutMonth == null && i >= retireState.idx && cash < -EPS && investments <= 1) {
      retireState.runsOutMonth = month;
      milestones.push({ kind: "money_runs_out", month, label: "Money runs out" });
    }

    const anyOwed = loans.some((l) => l.active && l.balance > EPS);
    const futureNew = loans.some((l) => l.isNew && !l.active);
    if (!debtFreeSeen && !anyOwed && !futureNew) {
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

  const debtLineAmounts = new Map(loans.map((l) => [l.key, l.amounts]));
  return {
    debtLineAmounts,
    debtLines: loans.filter((l) => l.isNew).map((l) => ({ key: l.key, label: l.label })),
    totals,
    opening,
    balances,
    loans: loans.map((l) => ({
      key: l.key,
      accountId: l.accountId,
      label: l.label,
      openingBalance: round2(l.openingBalance),
      payoffMonth: l.payoffMonth,
      interestTotal: round2(l.interestTotal),
      isNew: l.isNew,
    })),
    milestones,
    warnings,
    retirement: retireState,
  };
}
