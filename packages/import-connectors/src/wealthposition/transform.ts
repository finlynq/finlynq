// Pure transform: WP ExternalTransaction[] + resolved mapping → Finlynq shapes.
// Rules documented in the planning file; mirror the tests in ./transform.test.ts.

import type {
  ConnectorMappingResolved,
  ExternalTransaction,
  ExternalTransactionEntry,
  RawTransaction,
  TransformResult,
  TransformSplitRow,
} from "../types";

interface ClassifiedEntry {
  entry: ExternalTransactionEntry;
  amount: number;
  /** Finlynq account id when this entry maps to an account. */
  accountId?: number;
  accountName?: string;
  /** Finlynq category id when this entry maps to a category. null = uncategorized. */
  categoryId?: number | null;
  categoryName?: string;
  /** External account metadata — for transfer payee strings. */
  externalAccountName?: string;
}

function parseAmount(raw: string | number): number {
  if (typeof raw === "number") return raw;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : NaN;
}

function parseHolding(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Main transform. Doesn't throw on bad input — collects errors per external
 * tx id and returns them in the TransformResult.
 */
export function transformTransactions(
  externalTxs: ExternalTransaction[],
  mapping: ConnectorMappingResolved,
  /**
   * By-name maps for fast classification. Computed once in the orchestrator
   * and passed in. Kept separate from ConnectorMappingResolved so the
   * types stay minimal.
   */
  byName: {
    externalAccountByName: Map<string, string>; // name → external id
    externalCategoryByName: Map<string, string>; // name → external id
  },
): TransformResult {
  const flat: RawTransaction[] = [];
  const splits: TransformResult["splits"] = [];
  const errors: TransformResult["errors"] = [];

  for (const tx of externalTxs) {
    const classified = tx.entries.map((e) => classifyEntryFull(e, mapping, byName));

    // Validate amounts
    const badAmount = classified.find((c) => !Number.isFinite(c.amount));
    if (badAmount) {
      errors.push({
        externalId: tx.id,
        reason: `Entry "${badAmount.entry.categorization}" has non-numeric amount "${badAmount.entry.amount}"`,
      });
      continue;
    }

    const accountSides = classified.filter((c) => c.accountId !== undefined);
    const categorySides = classified.filter((c) => c.categoryId !== undefined || c.categoryName !== undefined);
    const unknown = classified.filter(
      (c) => c.accountId === undefined && c.categoryId === undefined && c.categoryName === undefined,
    );

    if (unknown.length > 0) {
      errors.push({
        externalId: tx.id,
        reason: `Unmapped entry "${unknown[0].entry.categorization}". Add it to the mapping and re-sync.`,
      });
      continue;
    }

    // 1-entry unconfirmed
    if (classified.length === 1) {
      const only = classified[0];
      if (only.accountId !== undefined && only.accountName) {
        flat.push(
          buildRawTransaction({
            date: tx.date,
            accountName: only.accountName,
            amount: only.amount,
            currency: only.entry.currency,
            payee: tx.payee || only.entry.note,
            note: only.entry.note,
            tags: tx.tags,
            category: undefined,
            holding: parseHolding(only.entry.holding),
          }),
        );
        continue;
      }
      errors.push({
        externalId: tx.id,
        reason: "Single-entry transaction did not resolve to an account.",
      });
      continue;
    }

    // 2 accounts = transfer
    if (accountSides.length === 2 && categorySides.length === 0) {
      const transferCatId = mapping.transferCategoryId;
      if (transferCatId === null) {
        errors.push({
          externalId: tx.id,
          reason: "Transfer category is not mapped. Pick one in the mapping dialog.",
        });
        continue;
      }
      const [a, b] = accountSides;
      flat.push(
        buildRawTransaction({
          date: tx.date,
          accountName: a.accountName!,
          amount: a.amount,
          currency: a.entry.currency,
          payee: tx.payee || `Transfer: ${b.externalAccountName ?? b.accountName ?? ""}`.trim(),
          note: a.entry.note,
          tags: tx.tags,
          category: mapping.categoryNameById.get(transferCatId),
          holding: parseHolding(a.entry.holding),
        }),
      );
      flat.push(
        buildRawTransaction({
          date: tx.date,
          accountName: b.accountName!,
          amount: b.amount,
          currency: b.entry.currency,
          payee: tx.payee || `Transfer: ${a.externalAccountName ?? a.accountName ?? ""}`.trim(),
          note: b.entry.note,
          tags: tx.tags,
          category: mapping.categoryNameById.get(transferCatId),
          holding: parseHolding(b.entry.holding),
        }),
      );
      continue;
    }

    // 1 account + N categories = split (or flat if N=1)
    if (accountSides.length === 1 && categorySides.length >= 1) {
      const acct = accountSides[0];
      if (categorySides.length === 1) {
        const cat = categorySides[0];
        flat.push(
          buildRawTransaction({
            date: tx.date,
            accountName: acct.accountName!,
            amount: acct.amount,
            currency: acct.entry.currency,
            payee: tx.payee || acct.entry.note || cat.entry.note,
            note: acct.entry.note || cat.entry.note,
            tags: tx.tags,
            category: cat.categoryName,
            holding: parseHolding(acct.entry.holding),
          }),
        );
        continue;
      }

      // True split: build parent + N split rows
      const parent = buildRawTransaction({
        date: tx.date,
        accountName: acct.accountName!,
        amount: acct.amount,
        currency: acct.entry.currency,
        payee: tx.payee || acct.entry.note,
        note: acct.entry.note,
        tags: tx.tags,
        category: undefined, // parent has no single category when splits are present
        holding: parseHolding(acct.entry.holding),
      });

      const splitRows: TransformSplitRow[] = categorySides.map((c) => ({
        categoryId: c.categoryId ?? null,
        amount: c.amount,
        note: c.entry.note,
      }));

      splits.push({ parent, splits: splitRows, externalId: tx.id });
      continue;
    }

    // Exotic shape (0 accounts, or 2+ accounts + categories, etc.)
    errors.push({
      externalId: tx.id,
      reason: `Unsupported shape: ${accountSides.length} account entr${accountSides.length === 1 ? "y" : "ies"} + ${categorySides.length} categor${categorySides.length === 1 ? "y" : "ies"}. Split, transfer, and simple 1A+1C are supported.`,
    });
  }

  return { flat, splits, errors };
}

function classifyEntryFull(
  entry: ExternalTransactionEntry,
  mapping: ConnectorMappingResolved,
  byName: {
    externalAccountByName: Map<string, string>;
    externalCategoryByName: Map<string, string>;
  },
): ClassifiedEntry {
  const amount = parseAmount(entry.amount);
  const name = entry.categorization;

  const externalAccountId = byName.externalAccountByName.get(name);
  if (externalAccountId) {
    const accountId = mapping.accountMap.get(externalAccountId);
    const ext = mapping.externalAccountById.get(externalAccountId);
    if (accountId !== undefined) {
      return {
        entry,
        amount,
        accountId,
        accountName: mapping.accountNameById.get(accountId),
        externalAccountName: ext?.name,
      };
    }
  }

  const externalCategoryId = byName.externalCategoryByName.get(name);
  if (externalCategoryId) {
    // categoryMap may have null values (explicit "leave uncategorized" choice)
    if (mapping.categoryMap.has(externalCategoryId)) {
      const categoryId = mapping.categoryMap.get(externalCategoryId) ?? null;
      return {
        entry,
        amount,
        categoryId,
        categoryName:
          categoryId !== null ? mapping.categoryNameById.get(categoryId) : undefined,
      };
    }
  }

  return { entry, amount };
}

interface BuildRawTransactionArgs {
  date: string;
  accountName: string;
  amount: number;
  currency?: string;
  payee?: string;
  note?: string;
  tags?: string[];
  category?: string;
  holding: number | null;
}

function buildRawTransaction(args: BuildRawTransactionArgs): RawTransaction {
  const row: RawTransaction = {
    date: args.date,
    account: args.accountName,
    amount: args.amount,
    payee: (args.payee || "").trim(),
    category: args.category,
    currency: args.currency,
    note: args.note,
    tags: args.tags && args.tags.length ? args.tags.join(",") : undefined,
  };
  // holding→quantity only when it's a distinct "units of something" number.
  // Cash accounts report holding == amount; skip in that case so we don't
  // spam quantity on every cash tx.
  if (args.holding !== null && Math.abs(args.holding - args.amount) > 1e-9) {
    row.quantity = args.holding;
  }
  return row;
}
