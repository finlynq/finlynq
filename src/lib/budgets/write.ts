/**
 * Budget v2 writes: one budget cell, the fill action, line and account
 * settings, carryover resets and edits. SERVER ONLY. Shared by the REST routes
 * and MCP `manage_budgets`, so both apply the same rules.
 *
 * Amounts are written in the display currency (no budget screen has ever
 * offered another one). Category ownership is checked before every write.
 */
import { sql } from "drizzle-orm";
import { db, withDbTransaction } from "@/db";
import { normalizeDbRows } from "@/lib/db-utils";
import { convertWithRateMap, getRateMap } from "@/lib/fx-service";
import { planFill, type FillAdjust, type FillLine, type FillSource } from "./fill";
import { isBudgetRole, parseLineKey, shiftMonth, type BudgetRole, type LineKey } from "./lines";
import { loadActualsByMonth, loadBudgetContext, loadBudgetsByMonth, type BudgetContext } from "./load-month";
import { groupLabel } from "./month";
import type { RolloverNegative } from "./carryover";

export class BudgetWriteError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

async function assertOwnCategory(userId: string, categoryId: number): Promise<{ type: string; group: string }> {
  const rows = normalizeDbRows<{ type: string; group: string }>(
    await db.execute(sql`SELECT type, "group" FROM categories WHERE id = ${categoryId} AND user_id = ${userId}`),
  );
  if (!rows.length) throw new BudgetWriteError("Category not found.", 404);
  return { type: rows[0].type, group: rows[0].group ?? "" };
}

async function upsertCategoryBudget(userId: string, categoryId: number, month: string, amount: number, currency: string) {
  await db.execute(sql`
    INSERT INTO budgets (user_id, category_id, month, amount, currency)
    VALUES (${userId}, ${categoryId}, ${month}, ${amount}, ${currency})
    ON CONFLICT (user_id, category_id, month)
    DO UPDATE SET amount = EXCLUDED.amount, currency = EXCLUDED.currency
  `);
}

async function upsertGroupBudget(userId: string, group: string, month: string, amount: number, currency: string) {
  await db.execute(sql`
    INSERT INTO budget_group_amounts (user_id, group_name, month, amount, currency)
    VALUES (${userId}, ${group}, ${month}, ${amount}, ${currency})
    ON CONFLICT (user_id, group_name, month)
    DO UPDATE SET amount = EXCLUDED.amount, currency = EXCLUDED.currency
  `);
}

/** Set (or clear, with null) one line's budget for one month. */
export async function setBudgetCell(
  userId: string,
  currency: string,
  key: string,
  month: string,
  amount: number | null,
): Promise<void> {
  const parsed = parseLineKey(key);
  if (!parsed) throw new BudgetWriteError("Unknown budget line.");
  if (amount != null && (!Number.isFinite(amount) || amount < 0)) {
    throw new BudgetWriteError("A budget must be 0 or more.");
  }
  if (parsed.kind === "category") {
    await assertOwnCategory(userId, parsed.categoryId);
    if (amount == null) {
      await db.execute(sql`DELETE FROM budgets WHERE user_id = ${userId} AND category_id = ${parsed.categoryId} AND month = ${month}`);
    } else {
      await upsertCategoryBudget(userId, parsed.categoryId, month, round2(amount), currency);
    }
    return;
  }
  if (amount == null) {
    await db.execute(sql`DELETE FROM budget_group_amounts WHERE user_id = ${userId} AND group_name = ${parsed.group} AND month = ${month}`);
  } else {
    await upsertGroupBudget(userId, parsed.group, month, round2(amount), currency);
  }
}

// ─── Fill ─────────────────────────────────────────────────────────────────────

export type FillScope = { kind: "all" } | { kind: "keys"; keys: string[] } | { kind: "group"; group: string };

export interface FillRequest {
  months: string[];
  source: FillSource;
  adjust?: FillAdjust | null;
  overwrite: boolean;
  scope: FillScope;
  section?: "spending" | "income";
  preview: boolean;
}

export interface FillResultRow {
  key: LineKey;
  name: string;
  month: string;
  amount: number;
  previous: number | null;
}

/** The lines a fill can write: spending lines (or income lines), honoring exclusion and group budgets. */
function fillLines(
  ctx: BudgetContext,
  section: "spending" | "income",
  actuals: Map<number, Record<string, number>>,
  budgets: { categories: Map<number, Record<string, number>>; groups: Map<string, Record<string, number>> },
): Array<FillLine & { name: string; group: string }> {
  const out: Array<FillLine & { name: string; group: string }> = [];
  const type = section === "income" ? "I" : "E";
  const groupsDone = new Set<string>();
  for (const c of ctx.categories) {
    if (c.type !== type || c.excluded) continue;
    const gs = type === "E" ? ctx.groupSettings.get(c.group) : undefined;
    if (gs?.excluded) continue;
    if (gs?.byGroup) {
      if (groupsDone.has(c.group)) continue;
      groupsDone.add(c.group);
      const spent: Record<string, number> = {};
      for (const m of ctx.categories) {
        if (m.type !== "E" || m.group !== c.group || m.excluded) continue;
        for (const [month, v] of Object.entries(actuals.get(m.id) ?? {})) spent[month] = round2((spent[month] ?? 0) + v);
      }
      out.push({ key: `g:${c.group}`, name: groupLabel(c.group), group: c.group, budgets: budgets.groups.get(c.group) ?? {}, spent });
      continue;
    }
    out.push({
      key: `c:${c.id}`,
      name: c.name,
      group: c.group,
      budgets: budgets.categories.get(c.id) ?? {},
      spent: actuals.get(c.id) ?? {},
    });
  }
  return out;
}

export async function runBudgetFill(userId: string, dek: Buffer | null, req: FillRequest): Promise<{ rows: FillResultRow[]; applied: boolean; total: number; currency: string }> {
  const months = [...new Set(req.months)].sort();
  if (!months.length) throw new BudgetWriteError("Pick at least one month.");
  if (months.length > 36) throw new BudgetWriteError("Fill at most 36 months at a time.");
  const ctx = await loadBudgetContext(userId, dek);
  const from = shiftMonth(months[0], -25);
  const to = months[months.length - 1];
  const [actuals, budgets] = await Promise.all([loadActualsByMonth(ctx, from, to), loadBudgetsByMonth(ctx, from, to)]);
  const all = fillLines(ctx, req.section ?? "spending", actuals, budgets);
  const scope = req.scope;
  const lines =
    scope.kind === "all"
      ? all
      : scope.kind === "keys"
        ? all.filter((l) => scope.keys.includes(l.key))
        : all.filter((l) => l.group === scope.group);
  const plan = planFill({
    lines,
    months,
    source: req.source,
    adjust: req.adjust ?? null,
    overwrite: req.overwrite,
    lastCompleteMonth: shiftMonth(ctx.currentMonth, -1),
  });
  const names = new Map(lines.map((l) => [l.key, l.name]));
  const rows: FillResultRow[] = plan.map((p) => ({ ...p, key: p.key as LineKey, name: names.get(p.key) ?? p.key }));
  if (!req.preview && rows.length) {
    await withDbTransaction(async () => {
      for (const r of rows) {
        const parsed = parseLineKey(r.key)!;
        if (parsed.kind === "category") await upsertCategoryBudget(userId, parsed.categoryId, r.month, r.amount, ctx.currency);
        else await upsertGroupBudget(userId, parsed.group, r.month, r.amount, ctx.currency);
      }
    });
  }
  return {
    rows,
    applied: !req.preview && rows.length > 0,
    total: round2(rows.reduce((s, r) => s + r.amount, 0)),
    currency: ctx.currency,
  };
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export interface LineSettingsPatch {
  excluded?: boolean;
  rollover?: boolean;
  rolloverNegative?: RolloverNegative;
  /** Expense groups only: budget the group as one line. */
  byGroup?: boolean;
}

async function upsertLineSettings(userId: string, target: { categoryId: number } | { group: string }, patch: LineSettingsPatch) {
  const excluded = patch.excluded ?? null;
  const rollover = patch.rollover ?? null;
  const negative = patch.rolloverNegative ?? null;
  const byGroup = patch.byGroup ?? null;
  if ("categoryId" in target) {
    await db.execute(sql`
      INSERT INTO budget_line_settings (user_id, category_id, excluded, rollover, rollover_negative)
      VALUES (${userId}, ${target.categoryId}, COALESCE(${excluded}::boolean, false), COALESCE(${rollover}::boolean, false), COALESCE(${negative}::text, 'carry'))
      ON CONFLICT (user_id, category_id) WHERE category_id IS NOT NULL
      DO UPDATE SET
        excluded = COALESCE(${excluded}::boolean, budget_line_settings.excluded),
        rollover = COALESCE(${rollover}::boolean, budget_line_settings.rollover),
        rollover_negative = COALESCE(${negative}::text, budget_line_settings.rollover_negative)
    `);
  } else {
    await db.execute(sql`
      INSERT INTO budget_line_settings (user_id, group_name, excluded, by_group, rollover, rollover_negative)
      VALUES (${userId}, ${target.group}, COALESCE(${excluded}::boolean, false), COALESCE(${byGroup}::boolean, false), COALESCE(${rollover}::boolean, false), COALESCE(${negative}::text, 'carry'))
      ON CONFLICT (user_id, group_name) WHERE group_name IS NOT NULL
      DO UPDATE SET
        excluded = COALESCE(${excluded}::boolean, budget_line_settings.excluded),
        by_group = COALESCE(${byGroup}::boolean, budget_line_settings.by_group),
        rollover = COALESCE(${rollover}::boolean, budget_line_settings.rollover),
        rollover_negative = COALESCE(${negative}::text, budget_line_settings.rollover_negative)
    `);
  }
}

async function ensureCarryStart(userId: string, target: { categoryId: number } | { group: string }, month: string, currency: string) {
  if ("categoryId" in target) {
    await db.execute(sql`
      INSERT INTO budget_carryover_sets (user_id, category_id, month, amount, currency)
      VALUES (${userId}, ${target.categoryId}, ${month}, 0, ${currency})
      ON CONFLICT (user_id, category_id, month) WHERE category_id IS NOT NULL DO NOTHING
    `);
  } else {
    await db.execute(sql`
      INSERT INTO budget_carryover_sets (user_id, group_name, month, amount, currency)
      VALUES (${userId}, ${target.group}, ${month}, 0, ${currency})
      ON CONFLICT (user_id, group_name, month) WHERE group_name IS NOT NULL DO NOTHING
    `);
  }
}

/**
 * Change a category's or an expense group's budget settings. `month` is the
 * month the user is looking at: rollover starts there, and switching a group
 * to one line moves its categories' budgets from that month on into the
 * group's (summed per month; an existing group amount is kept).
 */
export async function updateLineSettings(
  userId: string,
  currency: string,
  target: { categoryId: number } | { group: string },
  patch: LineSettingsPatch,
  month: string,
): Promise<{ movedBudgets: number }> {
  if ("categoryId" in target) {
    const cat = await assertOwnCategory(userId, target.categoryId);
    if (patch.byGroup != null) throw new BudgetWriteError("Only a group can be budgeted as one line.");
    if (patch.rollover && cat.type !== "E") throw new BudgetWriteError("Only spending can roll over.");
  }
  let movedBudgets = 0;
  // Rates are fetched before the transaction: no network I/O inside one.
  const rateMap = "group" in target && patch.byGroup === true ? await getRateMap(currency, userId) : null;
  await withDbTransaction(async () => {
    await upsertLineSettings(userId, target, patch);
    if (patch.rollover) await ensureCarryStart(userId, target, month, currency);
    if ("group" in target && patch.byGroup === true && rateMap) {
      const rows = normalizeDbRows<{ id: number; month: string; amount: number; currency: string | null }>(
        await db.execute(sql`
          SELECT b.id, b.month, b.amount, b.currency
            FROM budgets b JOIN categories c ON c.id = b.category_id
           WHERE b.user_id = ${userId} AND c.user_id = ${userId} AND c.type = 'E'
             AND c."group" = ${target.group} AND b.month >= ${month}
        `),
      );
      if (rows.length) {
        const byMonth = new Map<string, number>();
        for (const r of rows) {
          byMonth.set(r.month, (byMonth.get(r.month) ?? 0) + convertWithRateMap(Number(r.amount), r.currency ?? currency, rateMap));
        }
        for (const [m, total] of byMonth) {
          await db.execute(sql`
            INSERT INTO budget_group_amounts (user_id, group_name, month, amount, currency)
            VALUES (${userId}, ${target.group}, ${m}, ${round2(total)}, ${currency})
            ON CONFLICT (user_id, group_name, month) DO NOTHING
          `);
        }
        await db.execute(sql`
          DELETE FROM budgets WHERE user_id = ${userId}
             AND id IN (${sql.join(rows.map((r) => sql`${Number(r.id)}`), sql`, `)})
        `);
        movedBudgets = rows.length;
      }
    }
  });
  return { movedBudgets };
}

/** How an account counts in the budget (null = automatic), and a fixed planned payment. */
export async function setAccountBudgetRole(
  userId: string,
  accountId: number,
  role: BudgetRole | null,
  paymentAmount?: number | null,
): Promise<void> {
  if (role != null && !isBudgetRole(role)) throw new BudgetWriteError("Unknown budget role.");
  if (paymentAmount != null && (!Number.isFinite(paymentAmount) || paymentAmount < 0)) {
    throw new BudgetWriteError("A payment must be 0 or more.");
  }
  const rows = normalizeDbRows<{ id: number }>(
    await db.execute(
      paymentAmount === undefined
        ? sql`UPDATE accounts SET budget_role = ${role} WHERE id = ${accountId} AND user_id = ${userId} RETURNING id`
        : sql`UPDATE accounts SET budget_role = ${role}, budget_payment_amount = ${paymentAmount} WHERE id = ${accountId} AND user_id = ${userId} RETURNING id`,
    ),
  );
  if (!rows.length) throw new BudgetWriteError("Account not found.", 404);
}

/**
 * Pin what a rollover line carries into `month` (0 = reset), or remove the
 * user's own pin with null so the carry is computed again.
 */
export async function setCarryover(userId: string, currency: string, key: string, month: string, amount: number | null): Promise<void> {
  const parsed = parseLineKey(key);
  if (!parsed) throw new BudgetWriteError("Unknown budget line.");
  if (amount != null && !Number.isFinite(amount)) throw new BudgetWriteError("Enter an amount.");
  if (parsed.kind === "category") {
    await assertOwnCategory(userId, parsed.categoryId);
    if (amount == null) {
      await db.execute(sql`DELETE FROM budget_carryover_sets WHERE user_id = ${userId} AND category_id = ${parsed.categoryId} AND month = ${month}`);
      return;
    }
    await db.execute(sql`
      INSERT INTO budget_carryover_sets (user_id, category_id, month, amount, currency)
      VALUES (${userId}, ${parsed.categoryId}, ${month}, ${round2(amount)}, ${currency})
      ON CONFLICT (user_id, category_id, month) WHERE category_id IS NOT NULL
      DO UPDATE SET amount = EXCLUDED.amount, currency = EXCLUDED.currency
    `);
    return;
  }
  if (amount == null) {
    await db.execute(sql`DELETE FROM budget_carryover_sets WHERE user_id = ${userId} AND group_name = ${parsed.group} AND month = ${month}`);
    return;
  }
  await db.execute(sql`
    INSERT INTO budget_carryover_sets (user_id, group_name, month, amount, currency)
    VALUES (${userId}, ${parsed.group}, ${month}, ${round2(amount)}, ${currency})
    ON CONFLICT (user_id, group_name, month) WHERE group_name IS NOT NULL
    DO UPDATE SET amount = EXCLUDED.amount, currency = EXCLUDED.currency
  `);
}
