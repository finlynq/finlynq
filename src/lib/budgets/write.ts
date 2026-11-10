/**
 * Budget v2 writes: one budget cell, the fill action, line and account
 * settings, carryover resets and edits. SERVER ONLY. Shared by the REST routes
 * and MCP `manage_budgets`, so both apply the same rules.
 *
 * Amounts are written in the display currency (no budget screen has ever
 * offered another one). Category ownership is checked before every write.
 *
 * Budget rules (plan/budget-rules.md): a stored month's `amount` is always
 * its whole budget; rule writes and adjustments go through rule-store.ts,
 * which rewrites only the current and later months.
 */
import { sql } from "drizzle-orm";
import { db, withDbTransaction } from "@/db";
import { normalizeDbRows } from "@/lib/db-utils";
import { convertWithRateMap, getRateMap } from "@/lib/fx-service";
import { applyAdjust, planFill, sourceAmount, type FillAdjust, type FillLine, type FillSource } from "./fill";
import { isBudgetRole, monthRange, parseLineKey, shiftMonth, type BudgetRole, type LineKey } from "./lines";
import { loadActualsByMonth, loadBudgetContext, loadBudgetsByMonth, type BudgetContext } from "./load-month";
import { groupLabel } from "./month";
import type { RolloverNegative } from "./carryover";
import { BudgetWriteError } from "./errors";
import {
  applyRuleReplacement,
  assertOwnLine,
  currentMonth,
  hasActiveRule,
  insertRule,
  loadMoneyCtx,
  loadRules,
  recomputeRuleLines,
  rulesByLine,
  writeLineMonth,
} from "./rule-store";
import { planRuleReplacement, ruleAmountForMonth, type BudgetRuleView, type RuleIncrease } from "./rules";

export { BudgetWriteError };

const round2 = (n: number) => Math.round(n * 100) / 100;

async function assertOwnCategory(userId: string, categoryId: number): Promise<{ type: string; group: string }> {
  const rows = normalizeDbRows<{ type: string; group: string }>(
    await db.execute(sql`SELECT type, "group" FROM categories WHERE id = ${categoryId} AND user_id = ${userId}`),
  );
  if (!rows.length) throw new BudgetWriteError("Category not found.", 404);
  return { type: rows[0].type, group: rows[0].group ?? "" };
}

/**
 * Set (or clear, with null) one line's budget for one month: the month's
 * budget becomes exactly `amount`.
 *  - a month that has ended, or a line with no rule covering the month: a
 *    plain value, as before rules existed;
 *  - an open month a rule covers: "use only this amount" (the rules are
 *    ignored that month), so older phones and MCP get exactly what they typed;
 *    clearing removes that and the adjustment, leaving the rules' amount.
 */
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
  if (parsed.kind === "category") await assertOwnCategory(userId, parsed.categoryId);
  const open = month >= currentMonth();
  const rules = open ? await loadRules(userId, key) : [];
  if (!open || !hasActiveRule(rules, month)) {
    await writeLineMonth(userId, key, month, amount == null ? null : { amount: round2(amount), rulesAmount: null, override: false }, currency);
    return;
  }
  if (amount != null) {
    await writeLineMonth(userId, key, month, { amount: round2(amount), rulesAmount: null, override: true }, currency);
    return;
  }
  const money = await loadMoneyCtx(userId);
  await withDbTransaction(async () => {
    await writeLineMonth(userId, key, month, { amount: 0, rulesAmount: 0, override: false }, money.currency);
    await recomputeRuleLines(userId, money, { keys: [key], from: month, to: month });
  });
}

/**
 * The cell popover of an open month on a line with rules: the adjustment
 * added to (or, negative, taken off) the rules' amount, or "use only this
 * amount" (`override`, null to stop). The month's total may go below 0.
 */
export async function setBudgetAdjustment(
  userId: string,
  key: string,
  month: string,
  change: { adjustment?: number | null; override?: number | null },
): Promise<void> {
  await assertOwnLine(userId, key);
  if (month < currentMonth()) throw new BudgetWriteError("That month has ended; type its budget instead.");
  const money = await loadMoneyCtx(userId);
  if (change.override !== undefined && change.override !== null) {
    if (!Number.isFinite(change.override)) throw new BudgetWriteError("Enter an amount.");
    await writeLineMonth(userId, key, month, { amount: round2(change.override), rulesAmount: null, override: true }, money.currency);
    return;
  }
  // Stopping "use only this amount" (override: null) keeps any adjustment sent with it.
  const adj = change.adjustment ?? 0;
  if (!Number.isFinite(adj)) throw new BudgetWriteError("Enter an amount.");
  await withDbTransaction(async () => {
    // rulesAmount 0 marks the row as rule-made, so the recompute keeps only the adjustment.
    await writeLineMonth(userId, key, month, { amount: round2(adj), rulesAmount: 0, override: false }, money.currency);
    await recomputeRuleLines(userId, money, { keys: [key], from: month, to: month });
  });
}

// ─── Fill ─────────────────────────────────────────────────────────────────────

export type FillScope = { kind: "all" } | { kind: "keys"; keys: string[] } | { kind: "group"; group: string };

/**
 * values     - one value per month (MCP and older clients; the default)
 * this_month - the first month only, as "use only this amount" on a line with
 *              rules (a plain value otherwise)
 * rules      - one rule per line from the first month, ending at the last
 *              month or never (`noEnd`), carrying the increase; the line's
 *              overlapping rules are ended
 */
export type FillMode = "values" | "this_month" | "rules";

export interface FillRequest {
  months: string[];
  source: FillSource;
  adjust?: FillAdjust | null;
  overwrite: boolean;
  scope: FillScope;
  section?: "spending" | "income";
  preview: boolean;
  mode?: FillMode;
  noEnd?: boolean;
}

export interface FillResultRow {
  key: LineKey;
  name: string;
  month: string;
  amount: number;
  previous: number | null;
}

export interface FillRulePreview {
  key: LineKey;
  name: string;
  amount: number;
  startMonth: string;
  endMonth: string | null;
  increase: RuleIncrease | null;
  /** What the new rule gives its first months (up to 12). */
  months: Array<{ month: string; amount: number }>;
  /** The line's rules this one ends (`end`, at `newEndMonth`) or removes. */
  replaces: Array<{ id: number; amount: number; startMonth: string; endMonth: string | null; action: "end" | "remove"; newEndMonth?: string }>;
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

export async function runBudgetFill(
  userId: string,
  dek: Buffer | null,
  req: FillRequest,
): Promise<{ rows: FillResultRow[]; rules: FillRulePreview[]; applied: boolean; total: number; currency: string }> {
  const mode: FillMode = req.mode ?? "values";
  const sorted = [...new Set(req.months)].sort();
  if (!sorted.length) throw new BudgetWriteError("Pick at least one month.");
  if (sorted.length > 36) throw new BudgetWriteError("Fill at most 36 months at a time.");
  const months = mode === "this_month" ? [sorted[0]] : sorted;
  const ctx = await loadBudgetContext(userId, dek);
  const from = shiftMonth(months[0], -25);
  const to = months[months.length - 1];
  const [actuals, budgets, allRules] = await Promise.all([
    loadActualsByMonth(ctx, from, to),
    loadBudgetsByMonth(ctx, from, to),
    loadRules(userId),
  ]);
  const all = fillLines(ctx, req.section ?? "spending", actuals, budgets);
  const scope = req.scope;
  const lines =
    scope.kind === "all"
      ? all
      : scope.kind === "keys"
        ? all.filter((l) => scope.keys.includes(l.key))
        : all.filter((l) => l.group === scope.group);
  const byLine = rulesByLine(allRules);
  const current = currentMonth();
  const lastComplete = shiftMonth(ctx.currentMonth, -1);
  const base = shiftMonth(months[0], -1);

  if (mode === "rules") {
    const start = months[0];
    const end = req.noEnd ? null : months[months.length - 1];
    const adjust = req.adjust ?? null;
    const previews: FillRulePreview[] = [];
    for (const line of lines) {
      const src = sourceAmount(line, req.source, base, start, lastComplete);
      if (src == null) continue;
      const once = adjust && adjust.every === "once";
      const amount = round2(once ? applyAdjust(src, adjust, 0, base, start) : src);
      const increase: RuleIncrease | null =
        adjust && !once && adjust.value
          ? { mode: adjust.mode, value: adjust.value, every: adjust.every as "month" | "year", ...(adjust.every === "year" ? { stepMonth: adjust.stepMonth ?? 1 } : {}) }
          : null;
      const rule = { amount, currency: ctx.currency, startMonth: start, endMonth: end, increase };
      const shown = monthRange(start, end && end < shiftMonth(start, 11) ? end : shiftMonth(start, 11));
      const existing = byLine.get(line.key) ?? [];
      const plan = planRuleReplacement(existing, start, end);
      const byId = new Map(existing.map((r) => [r.id, r]));
      previews.push({
        key: line.key as LineKey,
        name: line.name,
        amount,
        startMonth: start,
        endMonth: end,
        increase,
        months: shown.map((m) => ({ month: m, amount: ruleAmountForMonth(rule, m) ?? 0 })),
        replaces: [
          ...plan.end.map((e) => ({ ...pickRule(byId.get(e.id)!), action: "end" as const, newEndMonth: e.endMonth })),
          ...plan.remove.map((id) => ({ ...pickRule(byId.get(id)!), action: "remove" as const })),
        ],
      });
    }
    if (!req.preview && previews.length) {
      const money = await loadMoneyCtx(userId);
      await withDbTransaction(async () => {
        for (const p of previews) {
          await applyRuleReplacement(userId, byLine.get(p.key) ?? [], p.startMonth, p.endMonth);
          await insertRule(userId, p.key, { amount: p.amount, startMonth: p.startMonth, endMonth: p.endMonth, increase: p.increase }, ctx.currency);
          // Months of the range that have already ended get the rule's amount
          // as a plain value, where they have no budget yet.
          const line = lines.find((l) => l.key === p.key)!;
          const rule = { amount: p.amount, currency: ctx.currency, startMonth: p.startMonth, endMonth: p.endMonth, increase: p.increase };
          const lastPast = p.endMonth && p.endMonth < shiftMonth(current, -1) ? p.endMonth : shiftMonth(current, -1);
          for (const m of monthRange(p.startMonth, lastPast)) {
            if (line.budgets[m] != null) continue;
            await writeLineMonth(userId, p.key, m, { amount: ruleAmountForMonth(rule, m) ?? 0, rulesAmount: null, override: false }, ctx.currency);
          }
        }
        await recomputeRuleLines(userId, money, { keys: previews.map((p) => p.key) });
      });
    }
    return {
      rows: [],
      rules: previews,
      applied: !req.preview && previews.length > 0,
      total: round2(previews.reduce((s, p) => s + (p.months[0]?.amount ?? 0), 0)),
      currency: ctx.currency,
    };
  }

  let rows: FillResultRow[];
  if (mode === "this_month") {
    const month = months[0];
    rows = [];
    for (const line of lines) {
      const previous = line.budgets[month] ?? null;
      if (!req.overwrite && previous != null) continue;
      const src = sourceAmount(line, req.source, base, month, lastComplete);
      if (src == null) continue;
      rows.push({ key: line.key as LineKey, name: line.name, month, amount: round2(src), previous });
    }
  } else {
    const plan = planFill({ lines, months, source: req.source, adjust: req.adjust ?? null, overwrite: req.overwrite, lastCompleteMonth: lastComplete });
    const names = new Map(lines.map((l) => [l.key, l.name]));
    rows = plan.map((p) => ({ ...p, key: p.key as LineKey, name: names.get(p.key) ?? p.key }));
  }
  if (!req.preview && rows.length) {
    await withDbTransaction(async () => {
      for (const r of rows) {
        // Exactly this amount: a plain value, or "use only this amount" on an
        // open month a rule covers (the same rule as typing the cell).
        const override = r.month >= current && hasActiveRule(byLine.get(r.key) ?? [], r.month);
        await writeLineMonth(userId, r.key, r.month, { amount: r.amount, rulesAmount: null, override }, ctx.currency);
      }
    });
  }
  return {
    rows,
    rules: [],
    applied: !req.preview && rows.length > 0,
    total: round2(rows.reduce((s, r) => s + r.amount, 0)),
    currency: ctx.currency,
  };
}

const pickRule = (r: BudgetRuleView) => ({ id: r.id, amount: r.amount, startMonth: r.startMonth, endMonth: r.endMonth });

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
      const current = currentMonth();
      const rows = normalizeDbRows<{ id: number; month: string; amount: number; currency: string | null; rules_amount: number | null; override: boolean }>(
        await db.execute(sql`
          SELECT b.id, b.month, b.amount, b.currency, b.rules_amount, b.override
            FROM budgets b JOIN categories c ON c.id = b.category_id
           WHERE b.user_id = ${userId} AND c.user_id = ${userId} AND c.type = 'E'
             AND COALESCE(c."group", '') = ${target.group} AND b.month >= ${month}
        `),
      );
      // The categories' rules become the group's; open months move only the
      // typed part (the rules' part comes back through the group's rules).
      const moved = normalizeDbRows<{ id: number }>(
        await db.execute(sql`
          UPDATE budget_rules SET category_id = NULL, group_name = ${target.group}, updated_at = NOW()
           WHERE user_id = ${userId} AND category_id IN (
             SELECT id FROM categories WHERE user_id = ${userId} AND type = 'E' AND COALESCE("group", '') = ${target.group}
           )
          RETURNING id
        `),
      );
      if (rows.length) {
        const byMonth = new Map<string, number>();
        for (const r of rows) {
          const typed = r.month < current || r.override ? Number(r.amount) : Number(r.amount) - Number(r.rules_amount ?? 0);
          byMonth.set(r.month, (byMonth.get(r.month) ?? 0) + convertWithRateMap(typed, r.currency ?? currency, rateMap));
        }
        for (const [m, total] of byMonth) {
          const open = m >= current;
          await db.execute(sql`
            INSERT INTO budget_group_amounts (user_id, group_name, month, amount, currency, rules_amount)
            VALUES (${userId}, ${target.group}, ${m}, ${round2(total)}, ${currency}, ${open ? 0 : null}::double precision)
            ON CONFLICT (user_id, group_name, month) DO NOTHING
          `);
        }
        await db.execute(sql`
          DELETE FROM budgets WHERE user_id = ${userId}
             AND id IN (${sql.join(rows.map((r) => sql`${Number(r.id)}`), sql`, `)})
        `);
        movedBudgets = rows.length;
      }
      if (rows.length || moved.length) {
        await recomputeRuleLines(userId, { currency, rateMap }, { keys: [`g:${target.group}`] });
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
