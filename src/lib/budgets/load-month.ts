/**
 * Loads a month's budget (Budget v2, plan/budget-v2.md). SERVER ONLY.
 *
 * What counts where — every transaction counts in at most one line:
 *  1. Only income (I) and expense (E) categories count; transfers sit in R
 *     categories and never do.
 *  2. Anything on an account whose budget role is `debt_payment` belongs to
 *     that account's debt line, never to its category. Loan interest is booked
 *     as an expense on the loan account, and the payment that covers it is
 *     already the debt line, so this is what stops counting it twice.
 *  3. Anything on an `excluded` account is left out.
 *  4. Everything else counts in its category (or its expense group, when the
 *     group is budgeted as one line).
 *
 * All amounts are in the display currency: budgets and planned loan payments
 * at the current rate, actual flows at their stored reporting amounts
 * (FINLYNQ-123).
 */
import { and, eq, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { normalizeDbRows } from "@/lib/db-utils";
import { convertWithRateMap, getDisplayCurrency, getRateMap } from "@/lib/fx-service";
import { convertReportingSlice } from "@/lib/fx/reporting-amount";
import { decryptName } from "@/lib/crypto/encrypted-columns";
import { safeName } from "@/lib/safe-name";
import { buildLoanSchedule, loanScheduleExtras, LoanValidationError } from "@/lib/loan-calculator";
import { occurrencesBetween } from "@/lib/subscriptions/schedule";
import { advanceStaleSubscriptionDatesSafe } from "@/lib/subscriptions/advance-next-dates";
import { todayISO } from "@/lib/utils/date";
import { walkCarryover, type RolloverNegative } from "./carryover";
import { debtStatus, scheduledInMonth, type ScheduleRowLike } from "./debt-line";
import {
  automaticBudgetRole,
  categoryKey,
  groupKey,
  monthEndDate,
  monthStartDate,
  resolveBudgetRole,
  shiftMonth,
  type BudgetRole,
} from "./lines";
import {
  buildBudgetMonth,
  type BudgetAccountInfo,
  type BudgetMonth,
  type DebtLine,
  type MonthCategoryInput,
  type MonthGroupSetting,
} from "./month";

type LoanRow = typeof schema.loans.$inferSelect;

export interface BudgetContext {
  userId: string;
  currency: string;
  rateMap: Map<string, number>;
  today: string;
  currentMonth: string;
  categories: MonthCategoryInput[];
  groupSettings: Map<string, MonthGroupSetting>;
  accounts: BudgetAccountInfo[];
  loansByAccount: Map<number, LoanRow[]>;
  /** Accounts whose transactions do NOT count by category. */
  nonCategoryAccountIds: number[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => (v == null ? 0 : Number(v));

export async function loadBudgetContext(
  userId: string,
  dek: Buffer | null,
  currencyOverride?: string | null,
): Promise<BudgetContext> {
  const currency = await getDisplayCurrency(userId, currencyOverride);
  const [rateMap, cats, settings, accounts, loans] = await Promise.all([
    getRateMap(currency, userId),
    db
      .select({
        id: schema.categories.id,
        nameCt: schema.categories.nameCt,
        group: schema.categories.group,
        type: schema.categories.type,
      })
      .from(schema.categories)
      .where(and(eq(schema.categories.userId, userId), inArray(schema.categories.type, ["E", "I"])))
      .all(),
    db.select().from(schema.budgetLineSettings).where(eq(schema.budgetLineSettings.userId, userId)).all(),
    db
      .select({
        id: schema.accounts.id,
        nameCt: schema.accounts.nameCt,
        type: schema.accounts.type,
        currency: schema.accounts.currency,
        isInvestment: schema.accounts.isInvestment,
        archived: schema.accounts.archived,
        budgetRole: schema.accounts.budgetRole,
        budgetPaymentAmount: schema.accounts.budgetPaymentAmount,
      })
      .from(schema.accounts)
      .where(eq(schema.accounts.userId, userId))
      .all(),
    db.select().from(schema.loans).where(eq(schema.loans.userId, userId)).all(),
  ]);

  const catSettings = new Map<number, (typeof settings)[number]>();
  const groupSettings = new Map<string, MonthGroupSetting>();
  for (const s of settings) {
    if (s.categoryId != null) catSettings.set(s.categoryId, s);
    else if (s.groupName != null) {
      groupSettings.set(s.groupName, {
        excluded: s.excluded,
        byGroup: s.byGroup,
        rollover: s.rollover,
        rolloverNegative: (s.rolloverNegative as RolloverNegative) ?? "carry",
      });
    }
  }

  const categories: MonthCategoryInput[] = cats.map((c) => {
    const s = catSettings.get(c.id);
    return {
      id: c.id,
      name: safeName(decryptName(c.nameCt, dek, null), "Category", c.id),
      group: c.group ?? "",
      type: c.type === "I" ? "I" : "E",
      excluded: !!s?.excluded,
      rollover: c.type === "E" && !!s?.rollover,
      rolloverNegative: (s?.rolloverNegative as RolloverNegative) ?? "carry",
    };
  });

  const loansByAccount = new Map<number, LoanRow[]>();
  for (const l of loans) {
    if (l.accountId == null) continue;
    loansByAccount.set(l.accountId, [...(loansByAccount.get(l.accountId) ?? []), l]);
  }

  const accountInfos: BudgetAccountInfo[] = accounts.map((a) => {
    const linked = loansByAccount.get(a.id) ?? [];
    const types = linked.map((l) => l.type);
    const stored = (a.budgetRole as BudgetRole | null) ?? null;
    return {
      id: a.id,
      name: safeName(decryptName(a.nameCt, dek, null), "Account", a.id),
      type: a.type,
      currency: a.currency,
      isInvestment: a.isInvestment,
      archived: a.archived,
      role: resolveBudgetRole(stored, types),
      storedRole: stored,
      automaticRole: automaticBudgetRole(types),
      paymentAmount: a.budgetPaymentAmount ?? null,
      linkedLoans: linked.map((l) => ({
        id: l.id,
        name: safeName(decryptName(l.nameCt, dek, null), "Loan", l.id),
        type: l.type,
      })),
    };
  });

  const today = todayISO();
  return {
    userId,
    currency,
    rateMap,
    today,
    currentMonth: today.slice(0, 7),
    categories,
    groupSettings,
    accounts: accountInfos,
    loansByAccount,
    nonCategoryAccountIds: accountInfos.filter((a) => a.role !== "categories").map((a) => a.id),
  };
}

/** Category id → month → amount: spending positive (refunds net) for E, received positive for I. */
export async function loadActualsByMonth(
  ctx: BudgetContext,
  fromMonth: string,
  toMonth: string,
): Promise<Map<number, Record<string, number>>> {
  const excludedClause = ctx.nonCategoryAccountIds.length
    ? sql`AND (t.account_id IS NULL OR t.account_id NOT IN (${sql.join(
        ctx.nonCategoryAccountIds.map((id) => sql`${id}`),
        sql`, `,
      )}))`
    : sql``;
  const rows = normalizeDbRows<{
    category_id: number;
    month: string;
    type: string;
    currency: string | null;
    reporting_currency: string | null;
    total_amount: number | null;
    total_reporting: number | null;
  }>(
    await db.execute(sql`
      SELECT t.category_id, SUBSTRING(t.date, 1, 7) AS month, c.type, t.currency, t.reporting_currency,
             SUM(t.amount) AS total_amount, SUM(t.reporting_amount) AS total_reporting
        FROM transactions t
        JOIN categories c ON c.id = t.category_id AND c.user_id = ${ctx.userId}
       WHERE t.user_id = ${ctx.userId}
         AND t.date >= ${monthStartDate(fromMonth)} AND t.date <= ${monthEndDate(toMonth)}
         AND c.type IN ('E', 'I')
         ${excludedClause}
       GROUP BY t.category_id, SUBSTRING(t.date, 1, 7), c.type, t.currency, t.reporting_currency
    `),
  );
  const out = new Map<number, Record<string, number>>();
  for (const r of rows) {
    const value = convertReportingSlice(
      {
        currency: r.currency,
        reportingCurrency: r.reporting_currency,
        totalAmount: r.total_amount == null ? null : Number(r.total_amount),
        totalReporting: r.total_reporting == null ? null : Number(r.total_reporting),
      },
      ctx.currency,
      ctx.rateMap,
    );
    const signed = r.type === "E" ? -value : value;
    const byMonth = out.get(Number(r.category_id)) ?? {};
    byMonth[r.month] = round2((byMonth[r.month] ?? 0) + signed);
    out.set(Number(r.category_id), byMonth);
  }
  return out;
}

/** Category and expense-group budgets per month, in the display currency. */
export async function loadBudgetsByMonth(
  ctx: BudgetContext,
  fromMonth: string,
  toMonth: string,
): Promise<{ categories: Map<number, Record<string, number>>; groups: Map<string, Record<string, number>> }> {
  const [cat, grp] = await Promise.all([
    normalizeDbRows<{ category_id: number; month: string; amount: number; currency: string | null }>(
      await db.execute(sql`
        SELECT category_id, month, amount, currency FROM budgets
         WHERE user_id = ${ctx.userId} AND month >= ${fromMonth} AND month <= ${toMonth}
      `),
    ),
    normalizeDbRows<{ group_name: string; month: string; amount: number; currency: string | null }>(
      await db.execute(sql`
        SELECT group_name, month, amount, currency FROM budget_group_amounts
         WHERE user_id = ${ctx.userId} AND month >= ${fromMonth} AND month <= ${toMonth}
      `),
    ),
  ]);
  const categories = new Map<number, Record<string, number>>();
  for (const b of cat) {
    const m = categories.get(Number(b.category_id)) ?? {};
    m[b.month] = round2(convertWithRateMap(num(b.amount), b.currency ?? ctx.currency, ctx.rateMap));
    categories.set(Number(b.category_id), m);
  }
  const groups = new Map<string, Record<string, number>>();
  for (const b of grp) {
    const m = groups.get(b.group_name) ?? {};
    m[b.month] = round2(convertWithRateMap(num(b.amount), b.currency ?? ctx.currency, ctx.rateMap));
    groups.set(b.group_name, m);
  }
  return { categories, groups };
}

/** Carryover resets and edits per line key, in the display currency. */
export async function loadCarrySets(ctx: BudgetContext): Promise<Map<string, Record<string, number>>> {
  const rows = normalizeDbRows<{ category_id: number | null; group_name: string | null; month: string; amount: number; currency: string | null }>(
    await db.execute(sql`
      SELECT category_id, group_name, month, amount, currency FROM budget_carryover_sets WHERE user_id = ${ctx.userId}
    `),
  );
  const out = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const key = r.category_id != null ? categoryKey(Number(r.category_id)) : groupKey(r.group_name ?? "");
    const m = out.get(key) ?? {};
    m[r.month] = round2(convertWithRateMap(num(r.amount), r.currency ?? ctx.currency, ctx.rateMap));
    out.set(key, m);
  }
  return out;
}

export function scheduleRowsForLoan(loan: LoanRow): ScheduleRowLike[] {
  try {
    return buildLoanSchedule({
      principal: loan.principal,
      annualRate: loan.annualRate,
      termMonths: loan.termMonths,
      startDate: loan.startDate,
      paymentAmount: loan.paymentAmount,
      paymentFrequency: loan.paymentFrequency,
      extraPayment: loan.extraPayment ?? 0,
      residualValue: loan.residualValue,
      ...loanScheduleExtras(loan),
    }).schedule;
  } catch (e) {
    if (e instanceof LoanValidationError) return [];
    throw e;
  }
}

/** One line per debt-payment account. */
export async function loadDebtLines(ctx: BudgetContext, month: string): Promise<DebtLine[]> {
  const debtAccounts = ctx.accounts.filter((a) => a.role === "debt_payment");
  if (!debtAccounts.length) return [];
  const ids = debtAccounts.map((a) => a.id);
  const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `);
  const start = monthStartDate(month);
  const end = monthEndDate(month);
  const paidRows = normalizeDbRows<{
    account_id: number;
    currency: string | null;
    reporting_currency: string | null;
    total_amount: number | null;
    total_reporting: number | null;
  }>(
    await db.execute(sql`
      SELECT account_id, currency, reporting_currency, SUM(amount) AS total_amount, SUM(reporting_amount) AS total_reporting
        FROM transactions
       WHERE user_id = ${ctx.userId} AND account_id IN (${idList})
         AND date >= ${start} AND date <= ${end}
         AND link_id IS NOT NULL AND amount > 0
       GROUP BY account_id, currency, reporting_currency
    `),
  );
  const paid = new Map<number, number>();
  for (const r of paidRows) {
    const v = convertReportingSlice(
      {
        currency: r.currency,
        reportingCurrency: r.reporting_currency,
        totalAmount: r.total_amount == null ? null : Number(r.total_amount),
        totalReporting: r.total_reporting == null ? null : Number(r.total_reporting),
      },
      ctx.currency,
      ctx.rateMap,
    );
    paid.set(Number(r.account_id), (paid.get(Number(r.account_id)) ?? 0) + v);
  }

  // Interest booked on each account this month, in its loans' interest categories.
  const interestCats = new Map<number, number[]>();
  for (const a of debtAccounts) {
    const catIds = (ctx.loansByAccount.get(a.id) ?? [])
      .map((l) => l.interestCategoryId)
      .filter((id): id is number => id != null);
    if (catIds.length) interestCats.set(a.id, catIds);
  }
  const booked = new Map<number, number>();
  for (const [accountId, catIds] of interestCats) {
    const rows = normalizeDbRows<{ currency: string | null; reporting_currency: string | null; total_amount: number | null; total_reporting: number | null }>(
      await db.execute(sql`
        SELECT currency, reporting_currency, SUM(amount) AS total_amount, SUM(reporting_amount) AS total_reporting
          FROM transactions
         WHERE user_id = ${ctx.userId} AND account_id = ${accountId}
           AND category_id IN (${sql.join(catIds.map((id) => sql`${id}`), sql`, `)})
           AND link_id IS NULL AND date >= ${start} AND date <= ${end}
         GROUP BY currency, reporting_currency
      `),
    );
    let total = 0;
    for (const r of rows) {
      total += convertReportingSlice(
        {
          currency: r.currency,
          reportingCurrency: r.reporting_currency,
          totalAmount: r.total_amount == null ? null : Number(r.total_amount),
          totalReporting: r.total_reporting == null ? null : Number(r.total_reporting),
        },
        ctx.currency,
        ctx.rateMap,
      );
    }
    booked.set(accountId, round2(-total));
  }

  const lines: DebtLine[] = [];
  for (const a of debtAccounts) {
    const loans = ctx.loansByAccount.get(a.id) ?? [];
    let planned = 0;
    let principal = 0;
    let interest = 0;
    const dueDates: string[] = [];
    let source: DebtLine["source"] = "none";
    for (const loan of loans) {
      const s = scheduledInMonth(scheduleRowsForLoan(loan), month);
      if (s.planned > 0) source = "schedule";
      const loanCurrency = loan.currency ?? a.currency;
      planned += convertWithRateMap(s.planned, loanCurrency, ctx.rateMap);
      principal += convertWithRateMap(s.principal, loanCurrency, ctx.rateMap);
      interest += convertWithRateMap(s.interest, loanCurrency, ctx.rateMap);
      dueDates.push(...s.dueDates);
    }
    if (source === "none" && a.paymentAmount != null && a.paymentAmount > 0) {
      planned = convertWithRateMap(a.paymentAmount, a.currency, ctx.rateMap);
      source = "fixed";
    }
    const paidAmt = round2(paid.get(a.id) ?? 0);
    if (a.archived && planned <= 0 && paidAmt <= 0) continue;
    dueDates.sort();
    lines.push({
      accountId: a.id,
      name: a.linkedLoans.length === 1 ? a.linkedLoans[0].name : a.name,
      planned: round2(planned),
      paid: paidAmt,
      principal: round2(principal),
      interest: round2(interest),
      bookedInterest: booked.has(a.id) ? booked.get(a.id)! : null,
      dueDates,
      status: debtStatus(round2(planned), paidAmt, dueDates, ctx.today),
      source,
      loanIds: loans.map((l) => l.id),
    });
  }
  return lines;
}

/**
 * Subscriptions and recurring payments still due this month, per category.
 * Only from tomorrow on (today and earlier are real transactions), and only
 * for the current month or later.
 */
export async function loadUpcoming(ctx: BudgetContext, month: string): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (month < ctx.currentMonth) return out;
  const tomorrow = shiftDay(ctx.today, 1);
  const from = month === ctx.currentMonth ? tomorrow : monthStartDate(month);
  const to = monthEndDate(month);
  if (from > to) return out;
  await advanceStaleSubscriptionDatesSafe(db, ctx.userId);
  const accountCurrency = new Map(ctx.accounts.map((a) => [a.id, a.currency]));
  const [subs, recurring] = await Promise.all([
    db
      .select({
        amount: schema.subscriptions.amount,
        currency: schema.subscriptions.currency,
        frequency: schema.subscriptions.frequency,
        nextDate: schema.subscriptions.nextDate,
        categoryId: schema.subscriptions.categoryId,
        status: schema.subscriptions.status,
      })
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.userId, ctx.userId))
      .all(),
    db
      .select({
        amount: schema.recurringTransactions.amount,
        frequency: schema.recurringTransactions.frequency,
        nextDate: schema.recurringTransactions.nextDate,
        categoryId: schema.recurringTransactions.categoryId,
        accountId: schema.recurringTransactions.accountId,
        active: schema.recurringTransactions.active,
      })
      .from(schema.recurringTransactions)
      .where(eq(schema.recurringTransactions.userId, ctx.userId))
      .all(),
  ]);
  const add = (categoryId: number, amount: number) =>
    out.set(categoryId, round2((out.get(categoryId) ?? 0) + amount));
  for (const s of subs) {
    if (s.status !== "active" || s.categoryId == null || !s.nextDate) continue;
    const n = occurrencesBetween(s.nextDate, s.frequency, from, to).length;
    if (n) add(s.categoryId, n * Math.abs(convertWithRateMap(Number(s.amount), s.currency, ctx.rateMap)));
  }
  for (const r of recurring) {
    if (r.active !== 1 || r.categoryId == null || !r.nextDate) continue;
    const n = occurrencesBetween(r.nextDate, r.frequency, from, to).length;
    const cur = (r.accountId != null ? accountCurrency.get(r.accountId) : null) ?? ctx.currency;
    if (n) add(r.categoryId, n * Math.abs(convertWithRateMap(Number(r.amount), cur, ctx.rateMap)));
  }
  return out;
}

function shiftDay(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The month at which the carry walk for any rollover line in `ctx` must start. */
function earliestCarryStart(ctx: BudgetContext, sets: Map<string, Record<string, number>>, month: string): string | null {
  let earliest: string | null = null;
  const consider = (key: string) => {
    const s = sets.get(key);
    if (!s) return;
    let best: string | null = null;
    for (const m of Object.keys(s)) if (m <= month && (best == null || m > best)) best = m;
    if (best && (earliest == null || best < earliest)) earliest = best;
  };
  for (const c of ctx.categories) if (c.rollover) consider(categoryKey(c.id));
  for (const [name, gs] of ctx.groupSettings) if (gs.byGroup && gs.rollover) consider(groupKey(name));
  return earliest;
}

/** The whole month model. */
export async function loadBudgetMonth(
  userId: string,
  dek: Buffer | null,
  month: string,
  currencyOverride?: string | null,
): Promise<BudgetMonth> {
  const ctx = await loadBudgetContext(userId, dek, currencyOverride);
  const sets = await loadCarrySets(ctx);
  const lastComplete = shiftMonth(ctx.currentMonth, -1);
  const avgEnd = shiftMonth(month, -1) < lastComplete ? shiftMonth(month, -1) : lastComplete;
  const avgStart = shiftMonth(avgEnd, -2);
  let from = avgStart < month ? avgStart : month;
  const carryStart = earliestCarryStart(ctx, sets, month);
  if (carryStart && carryStart < from) from = carryStart;
  const floor = shiftMonth(month, -120);
  if (from < floor) from = floor;

  const [actuals, budgets, debt, upcoming] = await Promise.all([
    loadActualsByMonth(ctx, from, month),
    loadBudgetsByMonth(ctx, from, month),
    loadDebtLines(ctx, month),
    loadUpcoming(ctx, month),
  ]);

  const monthActuals = new Map<number, number>();
  const averages = new Map<number, number>();
  for (const c of ctx.categories) {
    const byMonth = actuals.get(c.id) ?? {};
    monthActuals.set(c.id, byMonth[month] ?? 0);
    if (c.type === "E") {
      let sum = 0;
      for (let i = 0; i < 3; i++) sum += byMonth[shiftMonth(avgEnd, -i)] ?? 0;
      averages.set(c.id, round2(sum / 3));
    }
  }

  const carry = new Map<string, { carriedIn: number; left: number }>();
  for (const c of ctx.categories) {
    if (!c.rollover) continue;
    const key = categoryKey(c.id);
    const budgetsBy = budgets.categories.get(c.id) ?? {};
    const spentBy = actuals.get(c.id) ?? {};
    const months: Record<string, { budgeted: number; spent: number }> = {};
    for (const m of new Set([...Object.keys(budgetsBy), ...Object.keys(spentBy)])) {
      months[m] = { budgeted: budgetsBy[m] ?? 0, spent: spentBy[m] ?? 0 };
    }
    carry.set(key, walkCarryover({ target: month, sets: sets.get(key) ?? {}, months, negative: c.rolloverNegative }));
  }
  for (const [name, gs] of ctx.groupSettings) {
    if (!gs.byGroup || !gs.rollover) continue;
    const key = groupKey(name);
    const budgetsBy = budgets.groups.get(name) ?? {};
    const months: Record<string, { budgeted: number; spent: number }> = {};
    for (const [m, v] of Object.entries(budgetsBy)) months[m] = { budgeted: v, spent: 0 };
    for (const c of ctx.categories) {
      if (c.type !== "E" || c.group !== name || c.excluded) continue;
      for (const [m, v] of Object.entries(actuals.get(c.id) ?? {})) {
        months[m] = { budgeted: months[m]?.budgeted ?? 0, spent: (months[m]?.spent ?? 0) + v };
      }
    }
    carry.set(key, walkCarryover({ target: month, sets: sets.get(key) ?? {}, months, negative: gs.rolloverNegative }));
  }

  const monthBudgets = new Map<number, number>();
  for (const [id, byMonth] of budgets.categories) if (byMonth[month] != null) monthBudgets.set(id, byMonth[month]);
  const groupBudgets = new Map<string, number>();
  for (const [name, byMonth] of budgets.groups) if (byMonth[month] != null) groupBudgets.set(name, byMonth[month]);

  return buildBudgetMonth({
    month,
    currency: ctx.currency,
    today: ctx.today,
    categories: ctx.categories,
    groupSettings: ctx.groupSettings,
    budgets: monthBudgets,
    groupBudgets,
    actuals: monthActuals,
    averages,
    carry,
    upcoming,
    debt,
    accounts: ctx.accounts,
  });
}
