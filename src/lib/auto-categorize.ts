/**
 * FINLYNQ-84 — Transaction rules v2 matcher.
 *
 * Replaces the legacy flat `(match_field, match_type, match_value, ...)` shape
 * with a Zod-validated JSONB pair of `conditions` (AND-only ConditionGroup)
 * and `actions` (typed action array). Schemas: `src/lib/rules/schema.ts`.
 * Pure-action patcher + side-effect runner: `src/lib/rules/execute.ts`.
 *
 * Load-bearing invariants enforced here:
 * - AND-only composition (`conditions.all[]`) — no OR groups in v2.
 * - `applyRules()` returns the FIRST matching rule after priority DESC sort —
 *   keeps the legacy first-match-wins semantics so existing rule-priority
 *   intuition still holds.
 * - `matchesRule()` is pure (no DB I/O). Caller decrypts plaintext payee/note/
 *   tags ahead of time and hands a populated TransactionInput.
 */
import type { Condition, ConditionGroup, Action, Rule as RuleSchema } from "./rules/schema";

export interface TransactionInput {
  payee?: string | null;
  note?: string | null;
  tags?: string | null;
  amount?: number | null;
  accountId?: number | null;
  enteredCurrency?: string | null;
  /** YYYY-MM-DD. Used by date predicates (weekday/day_of_month/between). */
  date?: string | null;
}

/**
 * The persistable rule shape. Conditions + actions are JSONB; the matcher
 * parses them as the union types from `rules/schema.ts`. Caller is responsible
 * for narrowing the unknown JSONB into ConditionGroup + Action[] (typically
 * via the Zod schemas on the write path; reads trust the DB shape).
 */
export interface TransactionRule {
  id: number;
  name: string;
  conditions: ConditionGroup;
  actions: Action[];
  isActive: boolean;
  priority: number;
}

export interface RuleMatch {
  rule: TransactionRule;
  /** All actions on the matched rule. Caller picks via `computePureActionPatch` / `executeSideEffectActions`. */
  actions: Action[];
}

function evalStringOp(haystack: string, op: "contains" | "exact" | "regex", needle: string): boolean {
  if (op === "regex") {
    try {
      return new RegExp(needle, "i").test(haystack);
    } catch {
      return false;
    }
  }
  const a = haystack.toLowerCase();
  const b = needle.toLowerCase();
  if (op === "contains") return a.includes(b);
  if (op === "exact") return a === b;
  return false;
}

function evalNumberOp(value: number, op: "gt" | "lt" | "eq", target: number): boolean {
  if (op === "gt") return value > target;
  if (op === "lt") return value < target;
  if (op === "eq") return Math.abs(value - target) < 0.01;
  return false;
}

function evalSetOp<T>(value: T, op: "is" | "is_not", target: T): boolean {
  const eq = value === target;
  return op === "is" ? eq : !eq;
}

/**
 * UTC weekday from a YYYY-MM-DD string. Returns -1 on parse failure so the
 * condition trivially fails rather than throwing.
 */
function utcWeekday(dateStr: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return -1;
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return -1;
  return d.getUTCDay();
}

function utcDayOfMonth(dateStr: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return -1;
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return -1;
  return d.getUTCDate();
}

/**
 * Evaluate a single condition against a transaction input. Pure.
 */
export function evalCondition(txn: TransactionInput, cond: Condition): boolean {
  switch (cond.field) {
    case "payee":
    case "note":
    case "tags": {
      const value =
        cond.field === "payee" ? (txn.payee ?? "") :
        cond.field === "note" ? (txn.note ?? "") :
        (txn.tags ?? "");
      return evalStringOp(value, cond.op, cond.value);
    }
    case "amount": {
      const txAmount = txn.amount ?? 0;
      if (cond.op === "between") {
        return txAmount >= cond.min && txAmount <= cond.max;
      }
      return evalNumberOp(txAmount, cond.op, cond.value);
    }
    case "account":
      return evalSetOp(txn.accountId ?? null, cond.op, cond.accountId);
    case "currency": {
      const a = (txn.enteredCurrency ?? "").toUpperCase();
      const b = cond.value.toUpperCase();
      return evalSetOp(a, cond.op, b);
    }
    case "date": {
      const dateStr = txn.date ?? "";
      if (cond.op === "weekday") return utcWeekday(dateStr) === cond.weekday;
      if (cond.op === "day_of_month") return utcDayOfMonth(dateStr) === cond.day;
      if (cond.op === "between") {
        // Lexical compare on YYYY-MM-DD is correct because the strings sort
        // chronologically when zero-padded.
        return dateStr >= cond.from && dateStr <= cond.to;
      }
      return false;
    }
    default:
      // Exhaustiveness fallback — every case above is exhaustive over the
      // discriminated union, but TS narrowing makes this branch unreachable.
      return false;
  }
}

/**
 * AND-fold over `conditions.all[]`. Empty group is always false (creating a
 * rule with no conditions wouldn't pass Zod min(1) validation, but defensively
 * we refuse to match anything).
 */
export function matchesRule(txn: TransactionInput, rule: TransactionRule): boolean {
  if (!rule.isActive) return false;
  const conds = rule.conditions?.all ?? [];
  if (conds.length === 0) return false;
  return conds.every((c) => evalCondition(txn, c));
}

/**
 * Apply rules to a single transaction. Rules are sorted by priority DESC and
 * the first match wins (legacy first-match-wins semantics preserved).
 * Returns the matched rule + its full action list, or null if none match.
 */
export function applyRules(
  txn: TransactionInput,
  rules: TransactionRule[],
): RuleMatch | null {
  const sorted = [...rules].sort((a, b) => b.priority - a.priority);
  for (const rule of sorted) {
    if (matchesRule(txn, rule)) {
      return { rule, actions: rule.actions };
    }
  }
  return null;
}

/**
 * Apply rules to a batch of transactions.
 * Returns an array of results, one per transaction.
 */
export function applyRulesToBatch(
  transactions: TransactionInput[],
  rules: TransactionRule[],
): Array<{ index: number; match: RuleMatch | null }> {
  return transactions.map((txn, index) => ({
    index,
    match: applyRules(txn, rules),
  }));
}

/**
 * Suggest a category for a payee based on past transactions.
 * Returns the most common categoryId for the given payee, or null.
 *
 * NOTE: unchanged from pre-FINLYNQ-84 — operates on `transactions` history,
 * not rules. Kept here so callers don't have to import from a different module.
 */
export function suggestCategory(
  payee: string,
  existingTransactions: Array<{ payee?: string | null; categoryId?: number | null }>,
): number | null {
  if (!payee.trim()) return null;

  const payeeLower = payee.toLowerCase().trim();
  const matches = existingTransactions.filter(
    (t) => t.payee && t.payee.toLowerCase().trim() === payeeLower && t.categoryId,
  );

  if (matches.length === 0) return null;

  const counts = new Map<number, number>();
  for (const t of matches) {
    const catId = t.categoryId!;
    counts.set(catId, (counts.get(catId) ?? 0) + 1);
  }

  let bestId: number | null = null;
  let bestCount = 0;
  for (const [id, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      bestId = id;
    }
  }

  return bestId;
}

// Investment-account-aware auto-categorization helpers (#32). Unchanged.

export type InvestmentCategoryHint = {
  id: number;
  name: string;
  /** Category type: 'E' expense, 'I' income, 'R' reconciliation/transfer. */
  type: string;
};

function buildLowerNameIndex(categories: ReadonlyArray<InvestmentCategoryHint>): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of categories) {
    const key = c.name.trim().toLowerCase();
    if (key && !out.has(key)) out.set(key, c.id);
  }
  return out;
}

export function pickInvestmentCategoryByPayee(
  payee: string,
  categories: ReadonlyArray<InvestmentCategoryHint>,
): number | null {
  if (!payee) return null;
  const byLowerName = buildLowerNameIndex(categories);
  const find = (...names: string[]): number | null => {
    for (const n of names) {
      const id = byLowerName.get(n.toLowerCase());
      if (id !== undefined) return id;
    }
    return null;
  };

  const lower = payee.toLowerCase();

  if (lower.includes("dividend")) {
    const id = find("Dividends", "Dividend");
    if (id !== null) return id;
  }
  if (lower.includes("interest")) {
    const id = find("Credit Interest", "Interest Income", "Interest");
    if (id !== null) return id;
  }
  if (lower.includes("forex") || /\bfx\b/.test(lower) || lower.includes("currency")) {
    const id = find("Currency Revaluation", "Forex", "Transfers");
    if (id !== null) return id;
  }
  if (lower.includes("disbursement") || lower.includes("withdrawal")) {
    const id = find("Transfers", "Withdrawals");
    if (id !== null) return id;
  }

  return null;
}

export function fallbackInvestmentCategory(
  categories: ReadonlyArray<InvestmentCategoryHint>,
): number | null {
  const byLowerName = buildLowerNameIndex(categories);
  const transfers = byLowerName.get("transfers");
  if (transfers !== undefined) return transfers;
  const investActivity = byLowerName.get("investment activity");
  if (investActivity !== undefined) return investActivity;
  return null;
}

// Re-export so callers don't need a second import.
export type { RuleSchema };
