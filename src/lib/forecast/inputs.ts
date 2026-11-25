/**
 * SERVER ONLY. Builds the forecast's snapshot of real data (ForecastInputs)
 * through the helpers the rest of the app already uses, never copies of
 * their SQL (plan/forecast-scenarios.md section 10):
 *  - lines + budget months: the budget's own context and `loadBudgetsByMonth`
 *    (stored months, budget rules for any month, groups budgeted as one line,
 *    excluded categories/groups, display currency at the current rate);
 *  - loans: `buildLoanSchedule` + `loanScheduleExtras`, re-anchored to today by
 *    `projectLoanFromToday` exactly like the Loans page;
 *  - balances: `getAccountBalances` + `applyInvestmentMarketOverlay`
 *    (investments at market value, ledger fallback with a note).
 * The forecast starts NEXT month; opening balances are today's.
 */
import { convertWithRateMap } from "@/lib/fx-service";
import { getAccountBalances } from "@/lib/queries";
import { getHoldingsValueByAccount, verifyHoldingDecryptHealth } from "@/lib/holdings-value";
import { applyInvestmentMarketOverlay } from "@/lib/accounts/investment-balance-overlay";
import { isCashGroup } from "@/lib/accounts/groups";
import { decryptName } from "@/lib/crypto/encrypted-columns";
import { safeName } from "@/lib/safe-name";
import { buildLoanSchedule, loanScheduleExtras, LoanValidationError } from "@/lib/loan-calculator";
import { projectLoanFromToday } from "@/lib/loans/projection";
import { getLinkedAccountBalances } from "@/lib/loans/linked-account-balances";
import { loadActualsByMonth, loadBudgetContext, loadBudgetsByMonth, loadScheduledBetween } from "@/lib/budgets/load-month";
import { categoryKey, groupKey, monthEndDate, monthStartDate } from "@/lib/budgets/lines";
import { horizonEnd, loadRules, rulesByLine } from "@/lib/budgets/rule-store";
import { forecastMonths, shiftMonth } from "./layers";
import type { BudgetSeries, ForecastInputs, ForecastLineDef, LoanInput, PoolAccount } from "./types";

const round2 = (n: number) => Math.round(n * 100) / 100;
/** Inputs always cover the longest horizon (50 years), so any horizon change re-runs in the browser. */
export const FORECAST_INPUT_HORIZON_MONTHS = 600;
/** Complete past months loaded for the History and Budget realism layers. */
export const FORECAST_HISTORY_MONTHS = 24;

export async function loadForecastInputs(
  userId: string,
  dek: Buffer | null,
  opts: { horizonMonths?: number } = {},
): Promise<ForecastInputs> {
  const ctx = await loadBudgetContext(userId, dek);
  const maxHorizonMonths = Math.max(1, Math.min(opts.horizonMonths ?? FORECAST_INPUT_HORIZON_MONTHS, 600));
  const startMonth = shiftMonth(ctx.currentMonth, 1);
  const months = forecastMonths(startMonth, maxHorizonMonths);
  const endMonth = months[months.length - 1];
  const budgetHorizonEnd = horizonEnd(ctx.currentMonth);
  const notes: string[] = [];
  const leftOut: ForecastInputs["leftOut"] = [];

  // ── Lines (same rules as the budget page) ──────────────────────────────
  const coveredByLoan = new Set<number>();
  for (const a of ctx.accounts) {
    if (a.role !== "debt_payment") continue;
    for (const l of ctx.loansByAccount.get(a.id) ?? []) {
      if (l.interestCategoryId != null) coveredByLoan.add(l.interestCategoryId);
    }
  }
  const [budgets, rules] = await Promise.all([loadBudgetsByMonth(ctx, startMonth, endMonth), loadRules(userId)]);
  const ruleKeys = new Set(rulesByLine(rules).keys());

  const incomeLines: ForecastLineDef[] = [];
  const expenseLines: ForecastLineDef[] = [];
  const groupLines = new Map<string, ForecastLineDef>();
  /** Category id → the forecast line it counts in (its own, or its group's). */
  const keyOfCategory = new Map<number, string>();
  for (const c of ctx.categories) {
    const gs = c.type === "E" ? ctx.groupSettings.get(c.group) : undefined;
    if (c.excluded || gs?.excluded) continue;
    if (coveredByLoan.has(c.id)) {
      if (budgets.categories.has(c.id)) {
        leftOut.push({ key: categoryKey(c.id), label: c.name, reason: "Loan interest: the loan payment already includes it, so its budget is not counted again." });
      }
      continue;
    }
    if (c.type === "E" && gs?.byGroup) {
      const key = groupKey(c.group);
      if (!groupLines.has(key)) groupLines.set(key, { key, label: c.group || "Other", type: "expense", group: c.group });
      keyOfCategory.set(c.id, key);
      continue;
    }
    const line: ForecastLineDef = { key: categoryKey(c.id), label: c.name, type: c.type === "I" ? "income" : "expense", group: c.group };
    keyOfCategory.set(c.id, line.key);
    (c.type === "I" ? incomeLines : expenseLines).push(line);
  }
  const byGroupThenName = (a: ForecastLineDef, b: ForecastLineDef) =>
    a.group.localeCompare(b.group) || a.label.localeCompare(b.label);
  incomeLines.sort(byGroupThenName);
  const allExpense = [...expenseLines, ...groupLines.values()].sort(byGroupThenName);

  // ── Budget series ───────────────────────────────────────────────────────
  const budget: Record<string, BudgetSeries> = {};
  const seriesFor = (key: string, byMonth: Record<string, number> | undefined): BudgetSeries | null => {
    if (!byMonth || Object.keys(byMonth).length === 0) return null;
    const monthsIn = Object.fromEntries(Object.entries(byMonth).filter(([m]) => m >= startMonth && m <= endMonth));
    // Carry past the stored horizon only for lines WITHOUT rules (rules already
    // give any month) that still have a budget in the horizon's last month.
    let carryFrom: string | null = null;
    let carryAmount: number | null = null;
    const atEnd = byMonth[budgetHorizonEnd];
    const anyAfter = Object.keys(byMonth).some((m) => m > budgetHorizonEnd);
    if (!ruleKeys.has(key) && atEnd != null && !anyAfter) {
      carryFrom = budgetHorizonEnd;
      carryAmount = atEnd;
    }
    if (Object.keys(monthsIn).length === 0 && carryFrom == null) return null;
    return { months: monthsIn, carryFrom, carryAmount };
  };
  for (const l of [...incomeLines, ...allExpense]) {
    const s = l.key.startsWith("g:")
      ? seriesFor(l.key, budgets.groups.get(l.group))
      : seriesFor(l.key, budgets.categories.get(Number(l.key.slice(2))));
    if (s) budget[l.key] = s;
  }

  // ── History, past budgets, scheduled payments (Phase 2 layers) ─────────
  const historyFrom = shiftMonth(ctx.currentMonth, -FORECAST_HISTORY_MONTHS);
  const historyTo = shiftMonth(ctx.currentMonth, -1);
  const historyMonths = forecastMonths(historyFrom, FORECAST_HISTORY_MONTHS);
  const [actuals, pastBudgets, scheduledByCat] = await Promise.all([
    loadActualsByMonth(ctx, historyFrom, historyTo),
    loadBudgetsByMonth(ctx, historyFrom, historyTo),
    loadScheduledBetween(ctx, monthStartDate(startMonth), monthEndDate(endMonth)),
  ]);
  const sumInto = (target: Record<string, Record<string, number>>, key: string, byMonth: Record<string, number>) => {
    const t = target[key] ?? {};
    for (const [m, v] of Object.entries(byMonth)) t[m] = round2((t[m] ?? 0) + v);
    target[key] = t;
  };
  const history: Record<string, Record<string, number>> = {};
  for (const [catId, byMonth] of actuals) {
    const key = keyOfCategory.get(catId);
    if (key) sumInto(history, key, byMonth);
  }
  const pastBudget: Record<string, Record<string, number>> = {};
  for (const [catId, byMonth] of pastBudgets.categories) {
    const key = keyOfCategory.get(catId);
    if (key && key.startsWith("c:")) sumInto(pastBudget, key, byMonth);
  }
  for (const [group, byMonth] of pastBudgets.groups) {
    const key = groupKey(group);
    if (groupLines.has(key)) sumInto(pastBudget, key, byMonth);
  }
  const scheduled: Record<string, Record<string, number>> = {};
  let unassignedScheduled = 0;
  for (const [catId, byMonth] of scheduledByCat) {
    const key = keyOfCategory.get(catId);
    if (key) sumInto(scheduled, key, byMonth);
    else unassignedScheduled++;
  }
  if (unassignedScheduled) notes.push(`${unassignedScheduled} scheduled payment categor${unassignedScheduled === 1 ? "y is" : "ies are"} left out or excluded from the budget, so the Scheduled layer skips ${unassignedScheduled === 1 ? "it" : "them"}.`);

  // ── Balances and pools ─────────────────────────────────────────────────
  const rows = await getAccountBalances(userId, { includeArchived: true });
  const marked = await applyInvestmentMarketOverlay(
    rows.map((b) => ({ id: b.accountId, currency: b.currency, isInvestment: b.isInvestment === true, ledgerBalance: Number(b.balance) })),
    dek,
    () => getHoldingsValueByAccount(userId, dek),
    () => verifyHoldingDecryptHealth(userId, dek),
  );
  if (marked.note) notes.push(marked.note);
  const roleOf = new Map(ctx.accounts.map((a) => [a.id, a.role]));
  const accounts: PoolAccount[] = rows.map((b, i) => {
    const native = marked.rows[i]?.balance ?? Number(b.balance);
    const balance = round2(convertWithRateMap(native, b.currency, ctx.rateMap));
    const label = safeName(decryptName(b.accountNameCt, dek, null), "Account", b.accountId);
    let pool: PoolAccount["pool"];
    if (roleOf.get(b.accountId) === "debt_payment") pool = "loans";
    else if (b.isInvestment) pool = "investments";
    else if (b.accountType === "A") pool = isCashGroup(b.accountGroup) || !(b.accountGroup ?? "").trim() ? "cash" : "otherAssets";
    else pool = "otherLiabilities";
    return { id: b.accountId, label, pool, balance };
  });

  // ── Loans (debt-payment accounts) ───────────────────────────────────────
  const debtAccounts = ctx.accounts.filter((a) => a.role === "debt_payment");
  const acctBalances = await getLinkedAccountBalances(userId, debtAccounts.map((a) => a.id));
  const loans: LoanInput[] = [];
  const debtLines: ForecastLineDef[] = [];
  for (const a of debtAccounts) {
    const linked = ctx.loansByAccount.get(a.id) ?? [];
    const acct = acctBalances.get(a.id);
    const label = a.linkedLoans.length === 1 ? a.linkedLoans[0].name : a.name;
    const monthsOut: LoanInput["months"] = {};
    let opening = 0;
    let source: LoanInput["balanceSource"] = "projection";
    let terms: LoanInput["terms"] = null;
    if (linked.length > 1) notes.push(`${a.name} has ${linked.length} loans; they are projected from their own schedules, not the account balance.`);
    for (const loan of linked) {
      let summary;
      try {
        summary = buildLoanSchedule({
          principal: loan.principal,
          annualRate: loan.annualRate,
          termMonths: loan.termMonths,
          startDate: loan.startDate,
          paymentAmount: loan.paymentAmount,
          paymentFrequency: loan.paymentFrequency,
          extraPayment: loan.extraPayment ?? 0,
          residualValue: loan.residualValue,
          ...loanScheduleExtras(loan),
        });
      } catch (e) {
        if (e instanceof LoanValidationError) {
          notes.push(`${label}: its schedule can't be worked out (${e.message}), so it is left out.`);
          continue;
        }
        throw e;
      }
      const p = projectLoanFromToday(loan, summary, linked.length === 1 ? acct : undefined, ctx.today);
      const ccy = loan.currency ?? a.currency;
      const conv = (n: number) => convertWithRateMap(n, ccy, ctx.rateMap);
      // Re-amortizing (extra payments, refinancing, a debt strategy) needs the
      // rate and the monthly payment; only a single, calculated, rate-based loan
      // can be re-amortized honestly.
      terms = {
        annualRatePct: loan.annualRate,
        monthlyPayment: round2(conv(summary.monthlyEquivalentPayment + ((loan.extraPayment ?? 0) * summary.periodsPerYear) / 12)),
        residual: round2(conv(loan.residualValue ?? 0)),
        reamortizable: linked.length === 1 && summary.scheduleMode !== "manual" && summary.interestMethod === "rate",
      };
      opening += conv(p.remainingBalance);
      if (p.balanceSource === "account") source = "account";
      for (const r of p.upcoming) {
        const m = r.date.slice(0, 7);
        if (m < startMonth || m > endMonth) continue;
        const cur = monthsOut[m] ?? { payment: 0, interest: 0, principal: 0, balance: 0 };
        cur.payment += conv(r.payment);
        cur.interest += conv(r.interest);
        cur.principal += conv(r.principal);
        monthsOut[m] = cur;
      }
      // Balance after each month: this loan's last row in the month, carried through gaps.
      let bal = conv(p.remainingBalance);
      const byMonthBal = new Map<string, number>();
      for (const r of p.upcoming) byMonthBal.set(r.date.slice(0, 7), conv(r.balance));
      for (const m of months) {
        if (byMonthBal.has(m)) bal = byMonthBal.get(m)!;
        if (monthsOut[m]) monthsOut[m].balance += bal;
        else if (linked.length > 0) {
          // keep a balance entry only where the loan is still owed, so the
          // simulate stage can read it; payment 0 that month.
          if (bal > 0.005) monthsOut[m] = { payment: 0, interest: 0, principal: 0, balance: bal };
        }
      }
    }
    let fixedPayment: number | null = null;
    if (linked.length === 0) {
      // A debt account with no loan: its own balance, paid down by the fixed amount (no interest modelled).
      const owed = Math.max(0, -(accounts.find((x) => x.id === a.id)?.balance ?? 0));
      opening = owed;
      source = "fixed";
      fixedPayment = a.paymentAmount != null && a.paymentAmount > 0 ? round2(convertWithRateMap(a.paymentAmount, a.currency, ctx.rateMap)) : null;
      if (fixedPayment != null) terms = { annualRatePct: 0, monthlyPayment: fixedPayment, residual: 0, reamortizable: true };
      if (fixedPayment == null && owed > 0.005) notes.push(`${a.name} counts as a debt payment but has no loan or fixed payment, so it is not paid down in the forecast.`);
    }
    for (const m of Object.keys(monthsOut)) {
      const v = monthsOut[m];
      monthsOut[m] = { payment: round2(v.payment), interest: round2(v.interest), principal: round2(v.principal), balance: round2(v.balance) };
    }
    if (opening <= 0.005 && Object.keys(monthsOut).length === 0 && fixedPayment == null) continue;
    if (terms && linked.length > 1) terms = { ...terms, reamortizable: false };
    loans.push({ accountId: a.id, label, openingBalance: round2(opening), balanceSource: source, months: monthsOut, fixedPayment, terms });
    debtLines.push({ key: `debt:${a.id}`, label, type: "debt", group: "Debt payments" });
  }

  return {
    inputsAsOf: new Date().toISOString(),
    today: ctx.today,
    startMonth,
    currency: ctx.currency,
    maxHorizonMonths,
    budgetHorizonEnd,
    lines: [...incomeLines, ...allExpense, ...debtLines],
    budget,
    historyMonths,
    history,
    pastBudget,
    scheduled,
    loans,
    accounts,
    notes,
    leftOut,
  };
}
