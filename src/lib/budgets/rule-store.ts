/**
 * Budget rules: storage and the recompute that keeps stored months in step
 * with them (plan/budget-rules.md). SERVER ONLY.
 *
 * Every reader reads `budgets.amount` / `budget_group_amounts.amount` as the
 * month's whole budget, so rules are MATERIALIZED: whenever a rule or a
 * month's adjustment changes, the line's months from the CURRENT month to
 * HORIZON_MONTHS ahead are rewritten. A month before the current one is never
 * touched, which is what keeps history as plain values: editing, ending or
 * deleting a rule, or moving its start, cannot change a month that has ended.
 * Months beyond the stored horizon are computed on the fly by the budget page
 * (load-month.ts) and stored once the horizon reaches them (refreshRuleHorizon).
 */
import { sql } from "drizzle-orm";
import { db, withDbTransaction } from "@/db";
import { normalizeDbRows } from "@/lib/db-utils";
import { convertWithRateMap, getDisplayCurrency, getRateMap } from "@/lib/fx-service";
import { todayISO } from "@/lib/utils/date";
import { BudgetWriteError } from "./errors";
import { categoryKey, groupKey, monthRange, parseLineKey, shiftMonth, type LineKey } from "./lines";
import {
  isRuleActive,
  nextOpenMonth,
  planRuleReplacement,
  ruleAmountForMonth,
  rulesTotalForMonth,
  type BudgetRuleView,
  type RuleIncrease,
  type RuleShape,
  type StoredMonth,
} from "./rules";

/** Months stored ahead of today, the current month included. */
export const HORIZON_MONTHS = 36;
const THROUGH_KEY = "budget_rules_through";

const round2 = (n: number) => Math.round(n * 100) / 100;

export const currentMonth = (): string => todayISO().slice(0, 7);
export const horizonEnd = (current = currentMonth()): string => shiftMonth(current, HORIZON_MONTHS - 1);

export interface MoneyCtx {
  currency: string;
  rateMap: Map<string, number>;
}

/** Display currency + current rates. Network I/O: call BEFORE opening a transaction. */
export async function loadMoneyCtx(userId: string): Promise<MoneyCtx> {
  const currency = await getDisplayCurrency(userId);
  return { currency, rateMap: await getRateMap(currency, userId) };
}

type RuleRow = {
  id: number;
  category_id: number | null;
  group_name: string | null;
  amount: number;
  currency: string;
  start_month: string;
  end_month: string | null;
  increase_mode: string | null;
  increase_value: number | null;
  increase_every: string | null;
  step_month: number | null;
};

function toRule(r: RuleRow): BudgetRuleView {
  const increase: RuleIncrease | null =
    r.increase_mode && r.increase_every && r.increase_value != null && Number(r.increase_value) !== 0
      ? {
          mode: r.increase_mode as RuleIncrease["mode"],
          value: Number(r.increase_value),
          every: r.increase_every as RuleIncrease["every"],
          ...(r.increase_every === "year" ? { stepMonth: r.step_month ?? 1 } : {}),
        }
      : null;
  return {
    id: Number(r.id),
    key: r.category_id != null ? categoryKey(Number(r.category_id)) : groupKey(r.group_name ?? ""),
    amount: Number(r.amount),
    currency: r.currency,
    startMonth: r.start_month,
    endMonth: r.end_month,
    increase,
  };
}

/** Every rule of the user, or of one line. */
export async function loadRules(userId: string, key?: string): Promise<BudgetRuleView[]> {
  let filter = sql``;
  if (key) {
    const parsed = parseLineKey(key);
    if (!parsed) return [];
    filter = parsed.kind === "category" ? sql`AND category_id = ${parsed.categoryId}` : sql`AND group_name = ${parsed.group}`;
  }
  const rows = normalizeDbRows<RuleRow>(
    await db.execute(sql`
      SELECT id, category_id, group_name, amount, currency, start_month, end_month,
             increase_mode, increase_value, increase_every, step_month
        FROM budget_rules WHERE user_id = ${userId} ${filter}
       ORDER BY start_month, id
    `),
  );
  return rows.map(toRule);
}

export function rulesByLine(rules: readonly BudgetRuleView[]): Map<string, BudgetRuleView[]> {
  const out = new Map<string, BudgetRuleView[]>();
  for (const r of rules) out.set(r.key, [...(out.get(r.key) ?? []), r]);
  return out;
}

type StoredRow = StoredMonth & { month: string; currency: string };

/** Stored rows of the given lines between two months, keyed line → month. */
export async function loadStoredMonths(
  userId: string,
  keys: readonly string[],
  from: string,
  to: string,
): Promise<Map<string, Map<string, StoredRow>>> {
  const out = new Map<string, Map<string, StoredRow>>();
  const catIds: number[] = [];
  const groups: string[] = [];
  for (const k of keys) {
    const p = parseLineKey(k);
    if (p?.kind === "category") catIds.push(p.categoryId);
    else if (p?.kind === "group") groups.push(p.group);
  }
  const put = (key: string, r: { month: string; amount: number; rules_amount: number | null; override: boolean; currency: string | null }) => {
    const m = out.get(key) ?? new Map<string, StoredRow>();
    m.set(r.month, {
      month: r.month,
      amount: Number(r.amount),
      rulesAmount: r.rules_amount == null ? null : Number(r.rules_amount),
      override: !!r.override,
      currency: r.currency ?? "",
    });
    out.set(key, m);
  };
  if (catIds.length) {
    const rows = normalizeDbRows<{ category_id: number; month: string; amount: number; rules_amount: number | null; override: boolean; currency: string | null }>(
      await db.execute(sql`
        SELECT category_id, month, amount, rules_amount, override, currency FROM budgets
         WHERE user_id = ${userId} AND month >= ${from} AND month <= ${to}
           AND category_id IN (${sql.join(catIds.map((id) => sql`${id}`), sql`, `)})
      `),
    );
    for (const r of rows) put(categoryKey(Number(r.category_id)), r);
  }
  if (groups.length) {
    const rows = normalizeDbRows<{ group_name: string; month: string; amount: number; rules_amount: number | null; override: boolean; currency: string | null }>(
      await db.execute(sql`
        SELECT group_name, month, amount, rules_amount, override, currency FROM budget_group_amounts
         WHERE user_id = ${userId} AND month >= ${from} AND month <= ${to}
           AND group_name IN (${sql.join(groups.map((g) => sql`${g}`), sql`, `)})
      `),
    );
    for (const r of rows) put(groupKey(r.group_name), r);
  }
  return out;
}

/** A stored row in the display currency. */
export function inCurrency(row: StoredRow, money: MoneyCtx): StoredMonth {
  if (!row.currency || row.currency === money.currency) return row;
  const conv = (n: number) => round2(convertWithRateMap(n, row.currency, money.rateMap));
  return { amount: conv(row.amount), rulesAmount: row.rulesAmount == null ? null : conv(row.rulesAmount), override: row.override };
}

export const convertRule = (money: MoneyCtx) => (amount: number, currency: string) =>
  convertWithRateMap(amount, currency, money.rateMap);

/** Write one line-month: a row, or null to delete it. */
export async function writeLineMonth(userId: string, key: string, month: string, row: StoredMonth | null, currency: string): Promise<void> {
  await writeLineMonths(userId, key, [{ month, row }], currency);
}

/** Write several months of one line in at most two statements (null = delete that month). */
export async function writeLineMonths(
  userId: string,
  key: string,
  entries: ReadonlyArray<{ month: string; row: StoredMonth | null }>,
  currency: string,
): Promise<void> {
  const p = parseLineKey(key);
  if (!p) throw new BudgetWriteError("Unknown budget line.");
  const dels = entries.filter((e) => e.row == null).map((e) => e.month);
  const ups = entries.filter((e): e is { month: string; row: StoredMonth } => e.row != null);
  const target = p.kind === "category" ? sql`${p.categoryId}::integer` : sql`${p.group}::text`;
  const vals = (e: { month: string; row: StoredMonth }) =>
    sql`(${userId}, ${target}, ${e.month}, ${round2(e.row.amount)}::double precision, ${currency},
         ${e.row.rulesAmount == null ? null : round2(e.row.rulesAmount)}::double precision, ${e.row.override}::boolean)`;
  const monthList = sql.join(dels.map((m) => sql`${m}`), sql`, `);
  if (p.kind === "category") {
    if (dels.length) {
      await db.execute(sql`DELETE FROM budgets WHERE user_id = ${userId} AND category_id = ${p.categoryId} AND month IN (${monthList})`);
    }
    if (ups.length) {
      await db.execute(sql`
        INSERT INTO budgets (user_id, category_id, month, amount, currency, rules_amount, override)
        VALUES ${sql.join(ups.map(vals), sql`, `)}
        ON CONFLICT (user_id, category_id, month)
        DO UPDATE SET amount = EXCLUDED.amount, currency = EXCLUDED.currency,
                      rules_amount = EXCLUDED.rules_amount, override = EXCLUDED.override
      `);
    }
    return;
  }
  if (dels.length) {
    await db.execute(sql`DELETE FROM budget_group_amounts WHERE user_id = ${userId} AND group_name = ${p.group} AND month IN (${monthList})`);
  }
  if (ups.length) {
    await db.execute(sql`
      INSERT INTO budget_group_amounts (user_id, group_name, month, amount, currency, rules_amount, override)
      VALUES ${sql.join(ups.map(vals), sql`, `)}
      ON CONFLICT (user_id, group_name, month)
      DO UPDATE SET amount = EXCLUDED.amount, currency = EXCLUDED.currency,
                    rules_amount = EXCLUDED.rules_amount, override = EXCLUDED.override
    `);
  }
}

/**
 * Rewrite the open months of the given lines (all lines with rules when
 * `keys` is omitted) from their rules and adjustments. Never touches a month
 * before the current one. Run inside `withDbTransaction` by the caller.
 */
export async function recomputeRuleLines(
  userId: string,
  money: MoneyCtx,
  opts: { keys?: readonly string[]; from?: string; to?: string } = {},
): Promise<number> {
  const current = currentMonth();
  const from = opts.from && opts.from > current ? opts.from : current;
  const to = opts.to ?? horizonEnd(current);
  if (from > to) return 0;
  const byLine = rulesByLine(await loadRules(userId));
  const keys = [...new Set(opts.keys ?? [...byLine.keys()])];
  if (!keys.length) return 0;
  const stored = await loadStoredMonths(userId, keys, from, to);
  const convert = convertRule(money);
  let writes = 0;
  for (const key of keys) {
    const rules = byLine.get(key) ?? [];
    const rows = stored.get(key);
    const entries: Array<{ month: string; row: StoredMonth | null }> = [];
    for (const month of monthRange(from, to)) {
      const raw = rows?.get(month) ?? null;
      const row = raw ? inCurrency(raw, money) : null;
      const { total, active } = rulesTotalForMonth(rules, month, convert);
      let next = nextOpenMonth(row, total, active);
      // A row kept as it is but stored in another currency is rewritten in the display currency.
      if (next === undefined && raw && row && !raw.override && raw.currency && raw.currency !== money.currency && active > 0) next = row;
      if (next === undefined) continue;
      entries.push({ month, row: next });
    }
    if (entries.length) {
      await writeLineMonths(userId, key, entries, money.currency);
      writes += entries.length;
    }
  }
  return writes;
}

/**
 * Extend the stored months to the horizon once a month has passed (the
 * horizon moves forward with today). Cheap when nothing is due: one settings
 * read. Never throws; a failure leaves the page computing on the fly.
 */
export async function refreshRuleHorizon(userId: string): Promise<void> {
  try {
    const target = horizonEnd();
    const rows = normalizeDbRows<{ value: string }>(
      await db.execute(sql`SELECT value FROM settings WHERE key = ${THROUGH_KEY} AND user_id = ${userId}`),
    );
    if (rows[0]?.value === target) return;
    const anyRule = normalizeDbRows<{ id: number }>(await db.execute(sql`SELECT id FROM budget_rules WHERE user_id = ${userId} LIMIT 1`));
    const money = anyRule.length ? await loadMoneyCtx(userId) : null;
    await withDbTransaction(async () => {
      if (money) await recomputeRuleLines(userId, money);
      await markHorizon(userId, target);
    });
  } catch (e) {
    console.warn("[budgets] rule horizon refresh failed", e instanceof Error ? e.message : e);
  }
}

async function markHorizon(userId: string, target = horizonEnd()): Promise<void> {
  await db.execute(sql`
    INSERT INTO settings (key, user_id, value) VALUES (${THROUGH_KEY}, ${userId}, ${target})
    ON CONFLICT (key, user_id) DO UPDATE SET value = EXCLUDED.value
  `);
}

// ─── Rule writes ──────────────────────────────────────────────────────────────

export interface RuleInput {
  amount: number;
  startMonth: string;
  endMonth?: string | null;
  increase?: RuleIncrease | null;
}

/** The line must be the user's category, or an expense group the user has. */
export async function assertOwnLine(userId: string, key: string): Promise<{ kind: "category"; categoryId: number; type: string } | { kind: "group"; group: string }> {
  const p = parseLineKey(key);
  if (!p) throw new BudgetWriteError("Unknown budget line.");
  if (p.kind === "category") {
    const rows = normalizeDbRows<{ type: string }>(
      await db.execute(sql`SELECT type FROM categories WHERE id = ${p.categoryId} AND user_id = ${userId}`),
    );
    if (!rows.length) throw new BudgetWriteError("Category not found.", 404);
    if (rows[0].type !== "E" && rows[0].type !== "I") throw new BudgetWriteError("Only income and spending categories have budgets.");
    return { kind: "category", categoryId: p.categoryId, type: rows[0].type };
  }
  const rows = normalizeDbRows<{ n: number }>(
    await db.execute(sql`SELECT COUNT(*)::int AS n FROM categories WHERE user_id = ${userId} AND type = 'E' AND COALESCE("group", '') = ${p.group}`),
  );
  if (!rows.length || Number(rows[0].n) === 0) throw new BudgetWriteError("Category group not found.", 404);
  return { kind: "group", group: p.group };
}

function validateRule(input: RuleInput) {
  if (!Number.isFinite(input.amount) || input.amount < 0) throw new BudgetWriteError("A rule's amount must be 0 or more.");
  if (input.endMonth && input.endMonth < input.startMonth) throw new BudgetWriteError("The end month is before the start month.");
  const inc = input.increase;
  if (inc && (!Number.isFinite(inc.value) || (inc.every === "year" && inc.stepMonth != null && (inc.stepMonth < 1 || inc.stepMonth > 12)))) {
    throw new BudgetWriteError("Check the increase.");
  }
}

const incCols = (inc: RuleIncrease | null | undefined) =>
  inc && inc.value
    ? { mode: inc.mode, value: inc.value, every: inc.every, step: inc.every === "year" ? inc.stepMonth ?? 1 : null }
    : { mode: null, value: null, every: null, step: null };

/** Insert a rule (no recompute). */
export async function insertRule(userId: string, key: string, input: RuleInput, currency: string): Promise<number> {
  const p = parseLineKey(key)!;
  const i = incCols(input.increase);
  const rows = normalizeDbRows<{ id: number }>(
    await db.execute(sql`
      INSERT INTO budget_rules (user_id, category_id, group_name, amount, currency, start_month, end_month,
                                increase_mode, increase_value, increase_every, step_month)
      VALUES (${userId}, ${p.kind === "category" ? p.categoryId : null}::integer, ${p.kind === "group" ? p.group : null}::text,
              ${round2(input.amount)}, ${currency}, ${input.startMonth}, ${input.endMonth ?? null}::text,
              ${i.mode}::text, ${i.value}::double precision, ${i.every}::text, ${i.step}::integer)
      RETURNING id
    `),
  );
  return Number(rows[0].id);
}

async function ruleKey(userId: string, id: number): Promise<string> {
  const rows = normalizeDbRows<RuleRow>(
    await db.execute(sql`
      SELECT id, category_id, group_name, amount, currency, start_month, end_month,
             increase_mode, increase_value, increase_every, step_month
        FROM budget_rules WHERE id = ${id} AND user_id = ${userId}
    `),
  );
  if (!rows.length) throw new BudgetWriteError("Rule not found.", 404);
  return toRule(rows[0]).key;
}

/** Add a rule to a line and rewrite the line's open months. */
export async function createBudgetRule(userId: string, key: string, input: RuleInput): Promise<{ id: number }> {
  await assertOwnLine(userId, key);
  validateRule(input);
  const money = await loadMoneyCtx(userId);
  let id = 0;
  await withDbTransaction(async () => {
    id = await insertRule(userId, key, input, money.currency);
    await recomputeRuleLines(userId, money, { keys: [key] });
  });
  return { id };
}

/** Change a rule (every field) and rewrite the line's open months. */
export async function updateBudgetRule(userId: string, id: number, input: RuleInput): Promise<void> {
  const key = await ruleKey(userId, id);
  validateRule(input);
  const money = await loadMoneyCtx(userId);
  const i = incCols(input.increase);
  await withDbTransaction(async () => {
    await db.execute(sql`
      UPDATE budget_rules
         SET amount = ${round2(input.amount)}, currency = ${money.currency},
             start_month = ${input.startMonth}, end_month = ${input.endMonth ?? null}::text,
             increase_mode = ${i.mode}::text, increase_value = ${i.value}::double precision,
             increase_every = ${i.every}::text, step_month = ${i.step}::integer, updated_at = NOW()
       WHERE id = ${id} AND user_id = ${userId}
    `);
    await recomputeRuleLines(userId, money, { keys: [key] });
  });
}

/** Delete a rule and rewrite the line's open months; months that have ended keep their budgets. */
export async function deleteBudgetRule(userId: string, id: number): Promise<void> {
  const key = await ruleKey(userId, id);
  const money = await loadMoneyCtx(userId);
  await withDbTransaction(async () => {
    await db.execute(sql`DELETE FROM budget_rules WHERE id = ${id} AND user_id = ${userId}`);
    await recomputeRuleLines(userId, money, { keys: [key] });
  });
}

/** End or remove the line's rules a new rule from `start` replaces (no recompute). */
export async function applyRuleReplacement(userId: string, existing: readonly BudgetRuleView[], start: string, end: string | null): Promise<void> {
  const plan = planRuleReplacement(existing, start, end);
  for (const e of plan.end) {
    await db.execute(sql`UPDATE budget_rules SET end_month = ${e.endMonth}, updated_at = NOW() WHERE id = ${e.id} AND user_id = ${userId}`);
  }
  if (plan.remove.length) {
    await db.execute(sql`DELETE FROM budget_rules WHERE user_id = ${userId} AND id IN (${sql.join(plan.remove.map((id) => sql`${id}`), sql`, `)})`);
  }
}

export interface LineRulesView {
  key: string;
  currency: string;
  /** The first month shown (the month asked for, or the current month when that has ended). */
  from: string;
  rules: Array<BudgetRuleView & { fromMonthAmount: number | null }>;
  /** The line's next 12 months from `from`. */
  months: Array<{ month: string; fromRules: number; adjustment: number; override: boolean; total: number | null }>;
}

/** A line's rules and what its next 12 months come to (the Rules panel). */
export async function loadLineRulesView(userId: string, key: string, month: string): Promise<LineRulesView> {
  await assertOwnLine(userId, key);
  const money = await loadMoneyCtx(userId);
  const current = currentMonth();
  const from = month > current ? month : current;
  const to = shiftMonth(from, 11);
  const rules = await loadRules(userId, key);
  const stored = (await loadStoredMonths(userId, [key], from, to)).get(key);
  const convert = convertRule(money);
  const months = monthRange(from, to).map((m) => {
    const raw = stored?.get(m) ?? null;
    const row = raw ? inCurrency(raw, money) : null;
    const { total, active } = rulesTotalForMonth(rules, m, convert);
    const next = nextOpenMonth(row, total, active);
    const value = next === undefined ? (row ? row.amount : null) : next ? next.amount : null;
    return {
      month: m,
      fromRules: total,
      adjustment: row && !row.override ? round2(row.amount - (row.rulesAmount ?? 0)) : 0,
      override: !!row?.override,
      total: value == null ? null : round2(value),
    };
  });
  return {
    key,
    currency: money.currency,
    from,
    rules: rules.map((r) => {
      const a = ruleAmountForMonth(r, from);
      return { ...r, fromMonthAmount: a == null ? null : round2(convert(a, r.currency)) };
    }),
    months,
  };
}

/** Whether any of the line's rules covers `month`. */
export const hasActiveRule = (rules: readonly RuleShape[], month: string) => rules.some((r) => isRuleActive(r, month));

export type { LineKey };
