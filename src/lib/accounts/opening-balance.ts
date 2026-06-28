/**
 * FINLYNQ-206 — Opening balance backed by ONE linked transaction.
 *
 * The displayed "opening balance" for a cash (non-investment) account is
 * derived ENTIRELY from a single transaction carrying `kind='opening_balance'`.
 * There is NO `accounts.opening_balance` column — that transaction is the only
 * place the value lives, and `getAccountBalances` already SUMs it into the
 * running balance (queries.ts), so no read path special-cases it.
 *
 * Integrity:
 *  - Exactly one `kind='opening_balance'` row per (user, account), enforced by
 *    the partial unique index `transactions_one_opening_balance_per_account`
 *    (migration 20260627_opening_balance_unique.sql) — the field ↔ transaction
 *    stay 1:1.
 *  - The app NEVER deletes the row. Clearing the field ZEROES the linked row
 *    (amount → 0, row kept) per the no-programmatic-tx-delete invariant. Only
 *    the user deleting it from the Transactions UI removes it.
 *
 * Scope (v1): cash accounts only. Investment accounts are refused
 * (OpeningBalanceInvestmentError) — they don't take generic transactions and
 * value off `holdings.value`, so an opening balance there needs a different
 * mechanism (deferred follow-up).
 */
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { createTransaction, updateTransaction, getAccountById } from "@/lib/queries";
import { encryptField } from "@/lib/crypto/envelope";
import { buildNameFields, nameLookup } from "@/lib/crypto/encrypted-columns";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { todayISO } from "@/lib/utils/date";

const { transactions, categories } = schema;

export const OPENING_BALANCE_KIND = "opening_balance";
const OPENING_BALANCE_PAYEE = "Opening Balance";
const OPENING_BALANCE_NOTE = "Opening account balance";
/** Neutral category name (type 'R') — kept out of income/expense reports. */
const OPENING_BALANCE_CATEGORY = "Opening Balance";

export class OpeningBalanceInvestmentError extends Error {
  constructor() {
    super("Opening balance is not supported for investment accounts.");
    this.name = "OpeningBalanceInvestmentError";
  }
}

export class OpeningBalanceAccountNotFoundError extends Error {
  constructor() {
    super("Account not found.");
    this.name = "OpeningBalanceAccountNotFoundError";
  }
}

export type OpeningBalance = {
  transactionId: number;
  amount: number;
  date: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Read the single `kind='opening_balance'` transaction for an account, or null
 * when none. Owner-scoped — a cross-user / unknown account id returns null
 * (no leak). Amount + date are plaintext columns, so this needs no DEK.
 */
export async function getOpeningBalance(
  userId: string,
  accountId: number,
): Promise<OpeningBalance | null> {
  const row = await db
    .select({
      id: transactions.id,
      amount: transactions.amount,
      date: transactions.date,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.accountId, accountId),
        eq(transactions.kind, OPENING_BALANCE_KIND),
      ),
    )
    .limit(1)
    .get();
  if (!row) return null;
  return { transactionId: row.id, amount: row.amount, date: row.date };
}

/**
 * Find-or-create the per-user neutral "Opening Balance" category (`type='R'`).
 * `type='R'` keeps the row out of the income statement / spending reports
 * (those filter `type IN ('I','E')`) — TC-6. Mirrors the FINLYNQ-131
 * Transfer-category resolver: match by `name_lookup` HMAC, else auto-create.
 */
async function resolveOpeningBalanceCategoryId(
  userId: string,
  dek: Buffer,
): Promise<number> {
  const lookup = nameLookup(dek, OPENING_BALANCE_CATEGORY);
  const existing = await db
    .select({ id: categories.id })
    .from(categories)
    .where(
      and(
        eq(categories.userId, userId),
        eq(categories.type, "R"),
        eq(categories.nameLookup, lookup),
      ),
    )
    .orderBy(categories.id)
    .limit(1)
    .get();
  if (existing?.id) return existing.id;

  const enc = buildNameFields(dek, { name: OPENING_BALANCE_CATEGORY });
  const created = await db
    .insert(categories)
    .values({ userId, type: "R", group: "Adjustments", ...enc })
    .returning({ id: categories.id })
    .get();
  return created.id;
}

/**
 * Upsert the opening-balance transaction for a CASH account.
 *
 *  - amount null/0 + no existing row → no-op (returns null).
 *  - amount null/0 + existing row    → ZERO it in place (kept, NOT deleted).
 *  - amount non-zero + existing row  → update amount + date in place (one row).
 *  - amount non-zero + no existing   → create the kind='opening_balance' row.
 *
 * Edits/clears stamp `updated_at = NOW()` via `updateTransaction` (audit-trio).
 * Throws OpeningBalanceInvestmentError / OpeningBalanceAccountNotFoundError —
 * the route maps them to 400 / 404.
 */
export async function setOpeningBalance(
  userId: string,
  accountId: number,
  dek: Buffer,
  input: { amount: number | null; date?: string | null },
): Promise<OpeningBalance | null> {
  const account = await getAccountById(accountId, userId);
  if (!account) throw new OpeningBalanceAccountNotFoundError();
  if (account.isInvestment) throw new OpeningBalanceInvestmentError();

  const existing = await getOpeningBalance(userId, accountId);
  const amount =
    input.amount == null || !Number.isFinite(input.amount) ? 0 : input.amount;
  const date =
    input.date && ISO_DATE.test(input.date)
      ? input.date
      : (existing?.date ?? todayISO());

  // Clearing a field that was never set → nothing to do (TC-8 follow-up: a
  // user-deleted row reads as empty, and re-clearing stays a no-op).
  if (!existing && amount === 0) return null;

  if (existing) {
    const updated = await updateTransaction(existing.transactionId, userId, {
      amount,
      date,
    });
    invalidateUserTxCache(userId);
    return updated
      ? { transactionId: updated.id, amount: updated.amount, date: updated.date }
      : null;
  }

  const categoryId = await resolveOpeningBalanceCategoryId(userId, dek);
  const created = await createTransaction(
    userId,
    {
      date,
      accountId,
      categoryId,
      currency: account.currency,
      amount,
      payee: encryptField(dek, OPENING_BALANCE_PAYEE),
      note: encryptField(dek, OPENING_BALANCE_NOTE),
      kind: OPENING_BALANCE_KIND,
      source: "manual",
    },
    dek,
  );
  invalidateUserTxCache(userId);
  return created
    ? { transactionId: created.id, amount: created.amount, date: created.date }
    : null;
}
