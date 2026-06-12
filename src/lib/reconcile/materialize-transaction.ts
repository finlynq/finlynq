/**
 * materializeBankRowAsTransaction — shared bank-row → category-transaction
 * writer (FINLYNQ-150).
 *
 * Extracted verbatim from the inline body of
 * `src/app/api/reconcile/materialize/route.ts` so the web route AND the
 * `materialize_bank_row` MCP tool share ONE chokepoint (mirrors how
 * `materializeBankRowAsTransfer` is already shared by 3 callers). Duplicating
 * this logic in the MCP tool would create two drift points for the six
 * load-bearing invariants below.
 *
 * Creates a fresh `transactions` row mirrored from an existing
 * `bank_transactions` row + inserts a 'primary' `transaction_bank_links` row,
 * both in the SAME DB transaction so partial state can't be observed.
 *
 * Invariants honored (load-bearing — do NOT relax without reading
 * docs/invariants.md):
 *   - `source = 'reconcile_link'` — distinct writer attribution so the audit
 *     trail is honest about the materialization path.
 *   - `import_hash` copied VERBATIM from the bank row. NEVER recomputed.
 *     (Load-bearing dedup invariant — recomputing on a different payee would
 *     create a re-import gap on the next statement.)
 *   - `payee`/`note`/`tags` re-encrypted under the user's DEK regardless of
 *     the bank row's encryption_tier. transactions table is user-tier only.
 *   - `created_at = updated_at = NOW()` (audit-trio) via column defaults.
 *   - Sign-vs-category invariant enforced when a `categoryId` is provided.
 *   - Investment-account constraint: refuses materialize into an investment
 *     account (those require `portfolio_holding_id`, which this surface
 *     doesn't collect).
 *   - Cross-tenant FK guards on bank, account, and category ids → typed
 *     `*_not_found` codes (callers map to 404 / `err("Not found")`).
 *   - `invalidateUser(userId)` after commit (MCP per-user tx cache freshness).
 */

import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { encryptField, tryDecryptField } from "@/lib/crypto/envelope";
import { decryptStaged } from "@/lib/crypto/staging-envelope";
import { invalidateUser } from "@/lib/mcp/user-tx-cache";
import { validateSignVsCategoryById } from "@/lib/transactions/sign-category-invariant";

/** Stable machine codes for the expected refusals. The route maps the
 *  `*_not_found` family to 404 and the two business-rule codes to 400; the
 *  MCP tool maps `*_not_found` to `err("Not found")` and the business-rule
 *  codes to their explanatory message. */
export type MaterializeTxnFailCode =
  | "bank_not_found"
  | "account_not_found"
  | "category_not_found"
  | "investment_account_unsupported"
  | "sign_category_mismatch";

export type MaterializeTxnResult =
  | { ok: true; transactionId: number }
  | {
      ok: false;
      code: MaterializeTxnFailCode;
      /** Human-readable, safe to surface to end users. */
      message: string;
    };

export interface MaterializeBankRowAsTransactionInput {
  userId: string;
  dek: Buffer;
  bankTransactionId: string;
  /** Optional category to stamp on the materialized tx. Sign-vs-category +
   *  cross-tenant FK guards apply when set. */
  categoryId?: number | null;
  /** Optional target-account override. Defaults to the bank row's account;
   *  ownership re-checked. Never an investment account. */
  accountId?: number | null;
}

export async function materializeBankRowAsTransaction(
  input: MaterializeBankRowAsTransactionInput,
): Promise<MaterializeTxnResult> {
  const { userId, dek } = input;
  const categoryId = input.categoryId ?? null;

  // Load + ownership-check the bank row in one query.
  const bankRow = await db
    .select({
      id: schema.bankTransactions.id,
      accountId: schema.bankTransactions.accountId,
      date: schema.bankTransactions.date,
      amount: schema.bankTransactions.amount,
      currency: schema.bankTransactions.currency,
      enteredAmount: schema.bankTransactions.enteredAmount,
      enteredCurrency: schema.bankTransactions.enteredCurrency,
      enteredFxRate: schema.bankTransactions.enteredFxRate,
      quantity: schema.bankTransactions.quantity,
      payee: schema.bankTransactions.payee,
      note: schema.bankTransactions.note,
      tags: schema.bankTransactions.tags,
      encryptionTier: schema.bankTransactions.encryptionTier,
      importHash: schema.bankTransactions.importHash,
      fitId: schema.bankTransactions.fitId,
    })
    .from(schema.bankTransactions)
    .where(
      and(
        eq(schema.bankTransactions.id, input.bankTransactionId),
        eq(schema.bankTransactions.userId, userId),
      ),
    )
    .limit(1);
  if (!bankRow[0]) {
    return { ok: false, code: "bank_not_found", message: "Not found" };
  }
  const bank = bankRow[0];

  // Resolve target account. Default = bank row's account; override allowed
  // but ownership re-checked.
  const targetAccountId = input.accountId ?? bank.accountId;
  const acct = await db
    .select({
      id: schema.accounts.id,
      isInvestment: schema.accounts.isInvestment,
    })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.id, targetAccountId),
        eq(schema.accounts.userId, userId),
      ),
    )
    .limit(1);
  if (!acct[0]) {
    return { ok: false, code: "account_not_found", message: "Not found" };
  }
  if (acct[0].isInvestment) {
    // Investment accounts require a portfolio_holding_id on every tx
    // (CLAUDE.md "Investment-account constraint"). This surface doesn't
    // collect that; refuse cleanly and point the user at the manual flow.
    return {
      ok: false,
      code: "investment_account_unsupported",
      message:
        "Cannot materialize into an investment account from the reconcile surface. Use the manual transaction flow to select a holding.",
    };
  }

  // Decrypt payee/note/tags tier-aware, then re-encrypt under the user DEK.
  // transactions table is always user-tier; we don't preserve service-tier
  // wrappings across the materialization.
  const payeePlain = decodeBankString(bank.encryptionTier, dek, bank.payee);
  const notePlain = decodeBankString(bank.encryptionTier, dek, bank.note);
  const tagsPlain = decodeBankString(bank.encryptionTier, dek, bank.tags);

  // Sign-vs-category invariant — enforced BEFORE the INSERT so we don't
  // create-then-fail. The bank row's amount is the source of truth; we
  // never flip signs.
  if (categoryId != null) {
    const violation = await validateSignVsCategoryById(
      userId,
      dek,
      categoryId,
      bank.amount,
    );
    if (violation) {
      return {
        ok: false,
        code: "sign_category_mismatch",
        message: violation.message,
      };
    }
  }

  // Cross-tenant FK guard on categoryId.
  if (categoryId != null) {
    const cat = await db
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(
        and(
          eq(schema.categories.id, categoryId),
          eq(schema.categories.userId, userId),
        ),
      )
      .limit(1);
    if (!cat[0]) {
      return { ok: false, code: "category_not_found", message: "Not found" };
    }
  }

  // INSERT both rows in a single DB transaction.
  const inserted = await db.transaction(async (tx) => {
    const txRow = await tx
      .insert(schema.transactions)
      .values({
        userId,
        date: bank.date,
        accountId: targetAccountId,
        categoryId: categoryId ?? null,
        currency: bank.currency,
        amount: bank.amount,
        enteredCurrency: bank.enteredCurrency,
        enteredAmount: bank.enteredAmount,
        enteredFxRate: bank.enteredFxRate,
        quantity: bank.quantity,
        // Re-encrypt under user DEK. encryptField returns "" for empty
        // strings and null for null — matches the transactions table
        // column nullability (note/tags default to "", payee defaults to "").
        payee: encryptField(dek, payeePlain) ?? "",
        note: encryptField(dek, notePlain) ?? "",
        tags: encryptField(dek, tagsPlain) ?? "",
        importHash: bank.importHash,
        fitId: bank.fitId,
        bankTransactionId: bank.id,
        source: "reconcile_link",
        // createdAt + updatedAt + enteredAt all default to NOW() via the
        // column defaults — no need to set explicitly.
      })
      .returning({ id: schema.transactions.id });

    await tx.insert(schema.transactionBankLinks).values({
      userId,
      transactionId: txRow[0].id,
      bankTransactionId: bank.id,
      linkType: "primary",
      source: "reconcile_link",
    });

    return { transactionId: txRow[0].id };
  });

  invalidateUser(userId);

  return { ok: true, transactionId: inserted.transactionId };
}

/**
 * Tier-aware decrypt for one of the encrypted-in-place text columns on
 * `bank_transactions`. Mirrors the pattern in
 * `pf-app/src/lib/reconcile/bank-ledger-pool.ts` `decryptBankPayee`.
 */
function decodeBankString(
  tier: string | null,
  dek: Buffer,
  value: string | null,
): string | null {
  if (value == null || value === "") return value;
  if ((tier ?? "user") === "user") {
    return tryDecryptField(dek, value, "bank_transactions");
  }
  try {
    return decryptStaged(value);
  } catch {
    return null;
  }
}
