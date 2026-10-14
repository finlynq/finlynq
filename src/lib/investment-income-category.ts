/**
 * Resolve — or create — the category an investment Income/Expense row should
 * carry so it lands in the right report.
 *
 * Why this exists: portfolio Income (dividends/interest) and Fees are recorded
 * via `recordPortfolioIncomeOrExpense` with whatever `categoryId` the form
 * passes. That picker is optional with no default, so dividends frequently
 * land uncategorized — and the Dividend Income report
 * ([dividends.ts](src/lib/portfolio/dividends.ts)) matches ONLY on
 * `category_id == the user's "Dividends" category` (resolved by
 * [resolveDividendsCategoryId](src/lib/dividends-category.ts)). A dividend
 * without that exact category silently drops out of the dividend report.
 *
 * This helper takes an income TYPE (dividend / interest / fee) and returns the
 * matching category id, CREATING the canonical category when none of the
 * candidate names exist. The dividend create-name is the literal "Dividends"
 * so it agrees with `resolveDividendsCategoryId` — that symmetry is
 * load-bearing.
 *
 * Injectable `db` (mirrors `resolveDividendsCategoryId`) so REST, MCP-HTTP and
 * the backfill apply path all share one resolution and the unit test can pass
 * a fake.
 */

import { sql } from "drizzle-orm";
import { nameLookup, encryptName } from "./crypto/encrypted-columns";
import { normalizeDbRows } from "./db-utils";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = { execute: (q: ReturnType<typeof sql>) => Promise<any> };

export type InvestmentIncomeKind = "dividend" | "interest" | "fee";

/**
 * Existing-category lookup ladder per kind — first name that resolves wins.
 * Mirrors the keyword pass in
 * [auto-categorize.ts:pickInvestmentCategoryByPayee](src/lib/auto-categorize.ts)
 * so the form/route/MCP/backfill surfaces all converge on the same category.
 */
export const INCOME_CATEGORY_CANDIDATES: Record<InvestmentIncomeKind, string[]> = {
  dividend: ["Dividends", "Dividend"],
  interest: ["Interest Income", "Credit Interest", "Interest"],
  fee: ["Investment Fees", "Fees"],
};

/**
 * Category name to CREATE when none of the candidates exist.
 *
 * LOAD-BEARING: the dividend create-name MUST be exactly "Dividends" so the
 * row resolves through `resolveDividendsCategoryId` and shows in the Dividend
 * Income report.
 */
export const INCOME_CATEGORY_CREATE_NAME: Record<InvestmentIncomeKind, string> = {
  dividend: "Dividends",
  interest: "Interest",
  fee: "Investment Fees",
};

/** Category `type` for a freshly-created category. Dividends/Interest are income (I); fees are expense (E). */
export const INCOME_CATEGORY_CREATE_TYPE: Record<InvestmentIncomeKind, "I" | "E"> = {
  dividend: "I",
  interest: "I",
  fee: "E",
};

const CREATE_GROUP = "Investments";


async function findByName(
  db: DbLike,
  userId: string,
  dek: Buffer,
  name: string,
): Promise<number | null> {
  const lookup = nameLookup(dek, name);
  const result = await db.execute(sql`
    SELECT id FROM categories
    WHERE user_id = ${userId} AND name_lookup = ${lookup}
    LIMIT 1
  `);
  const rows = normalizeDbRows(result);
  return rows.length > 0 ? Number(rows[0].id) : null;
}

/**
 * Resolve the category id for an investment income/expense of `kind`,
 * creating the canonical category if the user has none.
 *
 * Returns `null` only when `dek` is absent (income writes are gated on
 * `requireEncryption`, so a DEK is always present in REST + MCP-HTTP +
 * backfill-apply contexts — the null path is a defensive no-op, never the
 * normal case).
 */
export async function resolveOrCreateInvestmentIncomeCategory(
  db: DbLike,
  userId: string,
  dek: Buffer | null,
  kind: InvestmentIncomeKind,
): Promise<number | null> {
  if (!dek) return null;

  // 1. Resolve an existing category by HMAC name_lookup.
  for (const name of INCOME_CATEGORY_CANDIDATES[kind]) {
    const id = await findByName(db, userId, dek, name);
    if (id != null) return id;
  }

  // 2. Create the canonical category.
  const createName = INCOME_CATEGORY_CREATE_NAME[kind];
  const { ct, lookup } = encryptName(dek, createName);
  const type = INCOME_CATEGORY_CREATE_TYPE[kind];
  try {
    const inserted = await db.execute(sql`
      INSERT INTO categories (user_id, type, "group", name_ct, name_lookup)
      VALUES (${userId}, ${type}, ${CREATE_GROUP}, ${ct}, ${lookup})
      RETURNING id
    `);
    const rows = normalizeDbRows(inserted);
    if (rows.length > 0) return Number(rows[0].id);
  } catch {
    // Likely a (user_id, name_lookup) unique race — fall through and re-resolve.
  }

  // 3. Re-resolve the create-name (covers the unique-violation race above).
  return findByName(db, userId, dek, createName);
}

/**
 * The user's investment-INCOME category ids: every existing category named
 * like a dividend or interest category (the same candidate names the
 * resolver above uses). Performance treats reinvested income in any OTHER
 * category as new money (performance/external-flows.ts). Needs the DEK
 * because category names are only matchable through their HMAC lookup;
 * returns null without one so the caller can fall back rather than guess.
 */
export async function findInvestmentIncomeCategoryIds(
  db: DbLike,
  userId: string,
  dek: Buffer | null,
): Promise<Set<number> | null> {
  if (!dek) return null;
  const names = [...INCOME_CATEGORY_CANDIDATES.dividend, ...INCOME_CATEGORY_CANDIDATES.interest];
  const lookups = names.map((n) => nameLookup(dek, n));
  const result = await db.execute(sql`
    SELECT id FROM categories
    WHERE user_id = ${userId} AND name_lookup IN (${sql.join(lookups.map((l) => sql`${l}`), sql`, `)})
  `);
  return new Set(normalizeDbRows(result).map((r) => Number((r as { id: unknown }).id)));
}
