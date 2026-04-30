import type { InferSelectModel } from "drizzle-orm";
import type { transactionRules } from "@/db/schema-pg";

export type TransactionRule = InferSelectModel<typeof transactionRules>;

export interface TransactionInput {
  payee?: string | null;
  amount?: number | null;
  tags?: string | null;
}

export interface RuleMatch {
  rule: TransactionRule;
  assignCategoryId: number | null;
  assignTags: string | null;
  renameTo: string | null;
}

/**
 * Test whether a single rule matches a transaction.
 */
function matchesRule(txn: TransactionInput, rule: TransactionRule): boolean {
  if (!rule.isActive) return false;

  const field = rule.matchField; // 'payee', 'amount', 'tags'
  const type = rule.matchType; // 'contains', 'exact', 'regex', 'greater_than', 'less_than'
  const value = rule.matchValue;

  if (field === "amount") {
    const txnAmount = txn.amount ?? 0;
    const ruleAmount = parseFloat(value);
    if (isNaN(ruleAmount)) return false;

    switch (type) {
      case "greater_than":
        return txnAmount > ruleAmount;
      case "less_than":
        return txnAmount < ruleAmount;
      case "exact":
        return Math.abs(txnAmount - ruleAmount) < 0.01;
      default:
        return false;
    }
  }

  // String-based matching for payee and tags
  const fieldValue = field === "payee" ? (txn.payee ?? "") : (txn.tags ?? "");
  const fieldLower = fieldValue.toLowerCase();
  const valueLower = value.toLowerCase();

  switch (type) {
    case "contains":
      return fieldLower.includes(valueLower);
    case "exact":
      return fieldLower === valueLower;
    case "regex":
      try {
        return new RegExp(value, "i").test(fieldValue);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

/**
 * Apply rules to a single transaction. Rules should be pre-sorted by priority (desc).
 * Returns the first matching rule, or null if none match.
 */
export function applyRules(
  txn: TransactionInput,
  rules: TransactionRule[],
): RuleMatch | null {
  // Sort by priority descending (highest priority first)
  const sorted = [...rules].sort((a, b) => b.priority - a.priority);

  for (const rule of sorted) {
    if (matchesRule(txn, rule)) {
      return {
        rule,
        assignCategoryId: rule.assignCategoryId,
        assignTags: rule.assignTags,
        renameTo: rule.renameTo,
      };
    }
  }
  return null;
}

/**
 * Suggest a category for a payee based on past transactions.
 * Returns the most common categoryId for the given payee, or null.
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

  // Count occurrences of each categoryId
  const counts = new Map<number, number>();
  for (const t of matches) {
    const catId = t.categoryId!;
    counts.set(catId, (counts.get(catId) ?? 0) + 1);
  }

  // Return the most common
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

// Investment-account-aware auto-categorization helpers (#32).
//
// When the MCP `record_transaction` / `bulk_record_transactions` tools write
// to an `is_investment=true` account with no explicit `category`, the regular
// rules+history fallback can land on an expense category meant for grocery /
// transport tracking — corrupting spending reports. These helpers route those
// writes to non-expense categories instead. Pure (no DB access) so the MCP
// caller decrypts category names once and we can unit-test the routing logic.

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

/**
 * Match a payee against a small set of investment-row keywords and return
 * the user's matching category id. Pattern (case-insensitive substrings):
 *   - `dividend`     → "Dividends"
 *   - `interest`     → "Credit Interest" / "Interest Income" / "Interest"
 *   - `forex` / `\bfx\b` / `currency` → "Currency Revaluation" / "Forex" / "Transfers"
 *   - `disbursement` / `withdrawal`   → "Transfers" / "Withdrawals"
 *
 * Returns null when nothing matches OR the user has no category by any of the
 * candidate names — caller should fall through to {@link fallbackInvestmentCategory}
 * or leave the row uncategorized.
 */
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

/**
 * Final fallback when no rule, keyword, or non-expense history match was
 * found for an investment-account write — prefer "Transfers", then a generic
 * "Investment Activity". Returns null when neither category exists.
 */
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
