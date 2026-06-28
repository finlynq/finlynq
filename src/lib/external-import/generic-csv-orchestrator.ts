/**
 * Generic multi-account CSV importer orchestrator.
 *
 * Bridges the pure `@finlynq/import-connectors` generic-csv transform to the
 * Finlynq import pipeline. The transform turns a "full ledger" CSV into
 * `RawTransaction[]` keyed by the source account NAME (under a caller-supplied
 * column mapping); the generic `executeImport` pipeline matches accounts /
 * categories BY NAME and does NOT auto-create them. So the orchestrator owns
 * the side effects, identically to the Money Pro orchestrator:
 *
 *   1. Group rows by source account → a per-account "plan" (modal currency,
 *      count, and whether it matches an existing Finlynq account by name).
 *   2. Refuse AMBIGUOUS cross-currency transfers — a same-currency-row transfer
 *      whose two legs resolve to accounts with different currencies is dropped +
 *      reported, since one source amount can't faithfully represent both sides.
 *      A transfer that supplies an explicit received amount + currency
 *      (`amountTo`/`currencyTo`) records each leg in its own currency and is
 *      KEPT — its legs already carry different currencies.
 *   3. On execute: resolve-or-create accounts + categories (encrypted names via
 *      `buildNameFields`), rewrite each row's `account` to the chosen Finlynq
 *      account name, then hand off to `executeImport` (txSource 'connector').
 *
 * Preview is read-only — it parses + summarizes so the user can confirm the
 * column mapping and map accounts before committing.
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
import { genericCsv } from "@finlynq/import-connectors";
import type {
  GenericCsvMapping,
  GenericCsvOptions,
} from "@finlynq/import-connectors/generic-csv";

const TRANSFER_CATEGORY = "Transfer";

export interface GenericCsvAccountPlan {
  /** Source account name exactly as it appears in the rows. */
  sourceName: string;
  /** Modal currency across the account's rows (e.g. "HKD"). */
  currency: string;
  /** How many emitted rows reference this account (either leg). */
  txCount: number;
  /** Existing Finlynq account id when the name matches one, else null. */
  matchedAccountId: number | null;
  matchedAccountName: string | null;
}

export interface GenericCsvSummary {
  totalRows: number;
  /** Emitted RawTransactions (each transfer expands to 2). */
  transactions: number;
  transfers: number;
  accounts: GenericCsvAccountPlan[];
  categories: string[];
  rowErrors: Array<{ row: number; reason: string }>;
}

/** Per-source-account decision sent from the client at execute time. */
export type GenericCsvAccountChoice =
  | { mode: "existing"; accountId: number }
  | { mode: "create"; currency: string; type: "A" | "L" };

export interface GenericCsvExecuteResult extends ImportResult {
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

/** Group transform output by account name → plans (MODAL currency + count + match). */
function buildAccountPlans(
  rows: RawTransaction[],
  existing: Map<string, DecryptedAccount>,
): GenericCsvAccountPlan[] {
  const byName = new Map<string, { counts: Map<string, number>; count: number }>();
  for (const r of rows) {
    const key = r.account.trim();
    if (!key) continue;
    const entry = byName.get(key) ?? { counts: new Map<string, number>(), count: 0 };
    entry.count += 1;
    const cur = r.currency ?? "USD";
    entry.counts.set(cur, (entry.counts.get(cur) ?? 0) + 1);
    byName.set(key, entry);
  }
  const plans: GenericCsvAccountPlan[] = [];
  for (const [sourceName, { counts, count }] of byName) {
    const currency = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "USD";
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

/**
 * Refuse only AMBIGUOUS cross-currency transfers. A transfer leg is identified
 * by a shared `linkId`. Two cases:
 *
 *   - The two legs carry DIFFERENT row currencies → an explicit FX transfer
 *     (the source amount + the received `amountTo`/`currencyTo`). Each leg
 *     already records its own side faithfully in its own currency, so it's KEPT
 *     regardless of the legs' account currencies.
 *   - The two legs carry the SAME row currency but resolve to accounts of
 *     different MODAL currency → ambiguous (no faithful received amount to set
 *     the other side) → dropped + reported as a skipped row.
 *
 * Returns the kept rows plus a synthetic error per refused transfer.
 */
function refuseCrossCurrencyTransfers(
  rows: RawTransaction[],
  plans: GenericCsvAccountPlan[],
): { kept: RawTransaction[]; errors: Array<{ row: number; reason: string }> } {
  const planCurrency = new Map<string, string>();
  for (const p of plans) planCurrency.set(p.sourceName.toLowerCase().trim(), p.currency);

  // linkId → its legs' accounts + the per-leg row currencies.
  const legAccounts = new Map<string, string[]>();
  const legCurrencies = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.linkId) continue;
    const list = legAccounts.get(r.linkId) ?? [];
    list.push(r.account);
    legAccounts.set(r.linkId, list);
    const curs = legCurrencies.get(r.linkId) ?? new Set<string>();
    curs.add((r.currency ?? "USD").toUpperCase());
    legCurrencies.set(r.linkId, curs);
  }

  const badLinks = new Set<string>();
  const errors: Array<{ row: number; reason: string }> = [];
  let synthRow = 100000; // distinct from transform row numbers
  for (const [linkId, accts] of legAccounts) {
    // Different leg currencies = explicit FX transfer with a received amount —
    // each side is faithful, keep it.
    if ((legCurrencies.get(linkId)?.size ?? 1) > 1) continue;
    const currencies = new Set(
      accts.map((a) => planCurrency.get(a.toLowerCase().trim()) ?? "USD"),
    );
    if (currencies.size > 1) {
      badLinks.add(linkId);
      errors.push({
        row: synthRow++,
        reason: `Cross-currency transfer ${accts.join(" → ")} (${[...currencies].join(
          " / ",
        )}) skipped — add an "amount received" + "currency received" column to import it faithfully.`,
      });
    }
  }

  const kept = badLinks.size === 0 ? rows : rows.filter((r) => !r.linkId || !badLinks.has(r.linkId));
  return { kept, errors };
}

/** Parse a generic-ledger CSV and summarize it for the preview UI (no writes). */
export async function summarizeGenericCsv(
  csvText: string,
  mapping: GenericCsvMapping,
  userId: string,
  dek: Buffer | null,
  opts: GenericCsvOptions = {},
): Promise<GenericCsvSummary> {
  const { transactions, errors } = genericCsv.parseGenericCsv(csvText, mapping, opts);
  const existing = await loadAccountsByName(userId, dek);
  const plansAll = buildAccountPlans(transactions, existing);
  const { kept, errors: xcErrors } = refuseCrossCurrencyTransfers(transactions, plansAll);
  const accounts = buildAccountPlans(kept, existing);

  const transfers = kept.filter((t) => t.linkId).length / 2;
  const categories = [
    ...new Set(
      kept
        .map((t) => t.category)
        .filter((c): c is string => !!c && c !== TRANSFER_CATEGORY),
    ),
  ].sort();
  const rowErrors = [
    ...errors.map((e) => ({ row: e.row, reason: e.reason })),
    ...xcErrors,
  ];
  return {
    totalRows: transactions.length + errors.length,
    transactions: kept.length,
    transfers: Math.round(transfers),
    accounts,
    categories,
    rowErrors,
  };
}

/**
 * Resolve-or-create accounts + categories, rewrite rows onto the chosen Finlynq
 * account names, and run the import. `accountChoices` maps each source account
 * name to a decision; unmapped source accounts default to "create new" with the
 * detected currency and Asset type.
 */
export async function executeGenericCsvImport(
  csvText: string,
  mapping: GenericCsvMapping,
  userId: string,
  dek: Buffer,
  accountChoices: Record<string, GenericCsvAccountChoice>,
  opts: GenericCsvOptions = {},
): Promise<GenericCsvExecuteResult> {
  const parsed = genericCsv.parseGenericCsv(csvText, mapping, opts);
  const existing = await loadAccountsByName(userId, dek);
  const plansForGuard = buildAccountPlans(parsed.transactions, existing);
  const { kept: transactions } = refuseCrossCurrencyTransfers(parsed.transactions, plansForGuard);

  if (transactions.length === 0) {
    return {
      total: 0,
      imported: 0,
      skippedDuplicates: 0,
      accountsCreated: 0,
      categoriesCreated: 0,
    };
  }

  const plans = buildAccountPlans(transactions, existing);

  // sourceName(lower) → target Finlynq account NAME the row must carry.
  const targetName = new Map<string, string>();
  let accountsCreated = 0;

  for (const plan of plans) {
    const key = plan.sourceName.toLowerCase().trim();
    const choice: GenericCsvAccountChoice =
      accountChoices[plan.sourceName] ??
      (plan.matchedAccountId
        ? { mode: "existing", accountId: plan.matchedAccountId }
        : { mode: "create", currency: plan.currency, type: "A" });

    if (choice.mode === "existing") {
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
    filename: "generic-csv-import.csv",
  });

  return { ...result, accountsCreated, categoriesCreated };
}
