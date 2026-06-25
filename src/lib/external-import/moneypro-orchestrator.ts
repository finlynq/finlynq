/**
 * Money Pro importer orchestrator (FINLYNQ — Phase 2).
 *
 * Bridges the pure `@finlynq/import-connectors` Money Pro transform to the
 * Finlynq import pipeline. The pure transform turns a Money Pro CSV into
 * `RawTransaction[]` keyed by the Money Pro account NAME; the generic
 * `previewImport`/`executeImport` pipeline matches accounts/categories BY NAME
 * and does NOT auto-create them. So the orchestrator owns the side effects:
 *
 *   1. Group rows by Money Pro account → a per-account "plan" (currency, count,
 *      and whether it matches an existing Finlynq account by name).
 *   2. On execute: resolve-or-create the target accounts + categories (encrypted
 *      names via `buildNameFields`), rewrite each row's `account` to the chosen
 *      Finlynq account name, then hand off to `executeImport` (txSource
 *      'connector'). Transfer legs ride through as two rows sharing `linkId`.
 *
 * Preview is read-only (no writes) — it parses + summarizes so the user can map
 * accounts before committing.
 */

import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { tryDecryptField } from "@/lib/crypto/envelope";
import { buildNameFields } from "@/lib/crypto/encrypted-columns";
import { createAccount, createCategory } from "@/lib/queries";
import {
  executeImport,
  type RawTransaction,
  type ImportResult,
} from "@/lib/import-pipeline";
import { moneypro } from "@finlynq/import-connectors";

const TRANSFER_CATEGORY = "Transfer";

export interface MoneyProAccountPlan {
  /** Money Pro account name exactly as it appears in the rows. */
  sourceName: string;
  /** Currency detected from the account's amounts (e.g. "HKD"). */
  currency: string;
  /** How many emitted rows reference this account (either leg). */
  txCount: number;
  /** Existing Finlynq account id when the name matches one, else null. */
  matchedAccountId: number | null;
  matchedAccountName: string | null;
}

export interface MoneyProSummary {
  totalRows: number;
  /** Emitted RawTransactions (each Money Transfer expands to 2). */
  transactions: number;
  transfers: number;
  accounts: MoneyProAccountPlan[];
  categories: string[];
  rowErrors: Array<{ row: number; reason: string }>;
}

/** Per-source-account decision sent from the client at execute time. */
export type MoneyProAccountChoice =
  | { mode: "existing"; accountId: number }
  | { mode: "create"; currency: string; type: "A" | "L" };

export interface MoneyProExecuteResult extends ImportResult {
  accountsCreated: number;
  categoriesCreated: number;
}

interface DecryptedAccount {
  id: number;
  name: string;
  currency: string;
}

/** Read + decrypt the user's accounts into a name→record map (lowercased key). */
async function loadAccountsByName(
  userId: string,
  dek: Buffer | null,
): Promise<Map<string, DecryptedAccount>> {
  const rows = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.userId, userId))
    .all();
  const map = new Map<string, DecryptedAccount>();
  for (const a of rows) {
    const name = a.nameCt && dek ? tryDecryptField(dek, a.nameCt, "accounts.name_ct") : null;
    if (!name) continue;
    map.set(name.toLowerCase().trim(), { id: a.id, name, currency: a.currency });
  }
  return map;
}

/** Read + decrypt the user's category names into a lowercased name set. */
async function loadCategoryNames(
  userId: string,
  dek: Buffer | null,
): Promise<Set<string>> {
  const rows = await db
    .select()
    .from(schema.categories)
    .where(eq(schema.categories.userId, userId))
    .all();
  const set = new Set<string>();
  for (const c of rows) {
    const name = c.nameCt && dek ? tryDecryptField(dek, c.nameCt, "categories.name_ct") : null;
    if (name) set.add(name.toLowerCase().trim());
  }
  return set;
}

/** Group transform output by account name → plans (currency + count + match). */
function buildAccountPlans(
  rows: RawTransaction[],
  existing: Map<string, DecryptedAccount>,
): MoneyProAccountPlan[] {
  const byName = new Map<string, { currency: string; count: number }>();
  for (const r of rows) {
    const key = r.account.trim();
    if (!key) continue;
    const cur = byName.get(key);
    if (cur) cur.count += 1;
    else byName.set(key, { currency: r.currency ?? "USD", count: 1 });
  }
  const plans: MoneyProAccountPlan[] = [];
  for (const [sourceName, { currency, count }] of byName) {
    const match = existing.get(sourceName.toLowerCase().trim()) ?? null;
    plans.push({
      sourceName,
      currency,
      txCount: count,
      matchedAccountId: match?.id ?? null,
      matchedAccountName: match?.name ?? null,
    });
  }
  return plans.sort((a, b) => b.txCount - a.txCount);
}

/** Parse a Money Pro CSV and summarize it for the preview UI (no writes). */
export async function summarizeMoneyProCsv(
  csvText: string,
  userId: string,
  dek: Buffer | null,
  opts: { defaultCurrency?: string } = {},
): Promise<MoneyProSummary> {
  const { transactions, errors } = moneypro.parseMoneyProCsv(csvText, {
    defaultCurrency: opts.defaultCurrency,
  });
  const existing = await loadAccountsByName(userId, dek);
  const accounts = buildAccountPlans(transactions, existing);
  const transfers = transactions.filter((t) => t.linkId).length / 2;
  const categories = [
    ...new Set(
      transactions
        .map((t) => t.category)
        .filter((c): c is string => !!c && c !== TRANSFER_CATEGORY),
    ),
  ].sort();
  return {
    totalRows: transactions.length + errors.length,
    transactions: transactions.length,
    transfers: Math.round(transfers),
    accounts,
    categories,
    rowErrors: errors.map((e) => ({ row: e.row, reason: e.reason })),
  };
}

/**
 * Resolve-or-create accounts + categories, rewrite rows onto the chosen
 * Finlynq account names, and run the import. `accountChoices` maps each Money
 * Pro source account name to a decision; unmapped source accounts default to
 * "create new" with the detected currency and Asset type.
 */
export async function executeMoneyProImport(
  csvText: string,
  userId: string,
  dek: Buffer,
  accountChoices: Record<string, MoneyProAccountChoice>,
  opts: { defaultCurrency?: string } = {},
): Promise<MoneyProExecuteResult> {
  const { transactions } = moneypro.parseMoneyProCsv(csvText, {
    defaultCurrency: opts.defaultCurrency,
  });
  if (transactions.length === 0) {
    return {
      total: 0,
      imported: 0,
      skippedDuplicates: 0,
      accountsCreated: 0,
      categoriesCreated: 0,
    };
  }

  const existing = await loadAccountsByName(userId, dek);
  const plans = buildAccountPlans(transactions, existing);

  // sourceName(lower) → target Finlynq account NAME the row must carry.
  const targetName = new Map<string, string>();
  let accountsCreated = 0;

  for (const plan of plans) {
    const key = plan.sourceName.toLowerCase().trim();
    const choice: MoneyProAccountChoice =
      accountChoices[plan.sourceName] ??
      (plan.matchedAccountId
        ? { mode: "existing", accountId: plan.matchedAccountId }
        : { mode: "create", currency: plan.currency, type: "A" });

    if (choice.mode === "existing") {
      // Find the chosen account's decrypted name to key the row against.
      const found = [...existing.values()].find((a) => a.id === choice.accountId);
      if (found) {
        targetName.set(key, found.name);
        continue;
      }
      // Stale id (account deleted) — fall through to create.
    }

    const currency = choice.mode === "create" ? choice.currency : plan.currency;
    const type = choice.mode === "create" ? choice.type : "A";
    const enc = buildNameFields(dek, { name: plan.sourceName });
    await createAccount(userId, {
      type,
      group: "",
      currency,
      isInvestment: false,
      ...enc,
    } as Parameters<typeof createAccount>[1]);
    accountsCreated += 1;
    targetName.set(key, plan.sourceName);
  }

  // Resolve-or-create categories (including the canonical "Transfer" bucket).
  // Type is inferred from the sign of the first row using the category.
  const existingCats = await loadCategoryNames(userId, dek);
  const neededCats = new Map<string, "I" | "E" | "R">();
  for (const r of transactions) {
    if (!r.category) continue;
    if (r.category === TRANSFER_CATEGORY) {
      if (!neededCats.has(TRANSFER_CATEGORY)) neededCats.set(TRANSFER_CATEGORY, "R");
      continue;
    }
    if (!neededCats.has(r.category)) {
      neededCats.set(r.category, r.amount >= 0 ? "I" : "E");
    }
  }
  let categoriesCreated = 0;
  for (const [name, type] of neededCats) {
    if (existingCats.has(name.toLowerCase().trim())) continue;
    const enc = buildNameFields(dek, { name });
    await createCategory(userId, {
      type,
      group: "",
      ...enc,
    } as Parameters<typeof createCategory>[1]);
    categoriesCreated += 1;
  }

  // Rewrite each row onto its chosen Finlynq account name so the pipeline's
  // name-match resolves. Drop rows whose account couldn't be resolved.
  const rewritten: RawTransaction[] = [];
  for (const r of transactions) {
    const name = targetName.get(r.account.toLowerCase().trim());
    if (!name) continue;
    rewritten.push({ ...r, account: name });
  }

  const result = await executeImport(rewritten, [], userId, dek, "connector", {
    filename: "money-pro-import.csv",
  });

  return { ...result, accountsCreated, categoriesCreated };
}
