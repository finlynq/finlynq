/**
 * POST /api/reconcile/materialize
 *
 * Body: { bankTransactionId: string, categoryId?: number, accountId?: number }
 *
 * Creates a fresh `transactions` row mirrored from an existing
 * `bank_transactions` row + inserts a 'primary' `transaction_bank_links` row.
 *
 * Use case: the user is on the reconcile page, sees a "bank-only" row
 * (bank ledger has it; no corresponding transaction — usually because the
 * user deleted the tx earlier or rejected the staged row), and wants to
 * materialize it as a real transaction. The new tx's lineage FK and the
 * join row are both set so the row stops being "bank-only" on next load.
 *
 * Invariants honored:
 *   - `source = 'reconcile_link'` — distinct writer attribution so the audit
 *     trail is honest about the materialization path.
 *   - `import_hash` copied VERBATIM from the bank row. NEVER recomputed.
 *     (Load-bearing dedup invariant — recomputing on a different payee
 *     would create a re-import gap on the next statement.)
 *   - `payee` re-encrypted under the user's DEK regardless of the bank
 *     row's encryption_tier. transactions table is user-tier only.
 *   - `created_at = updated_at = NOW()` (audit-trio).
 *   - Sign-vs-category invariant enforced when a `categoryId` is provided.
 *   - Cross-tenant FK guards on bank, account, and category ids.
 *   - Investment-account constraint: refuses materialize into an
 *     investment account (those require `portfolio_holding_id`, which
 *     this surface doesn't ask for). User can create the row manually
 *     through the normal flow with a holding selection.
 *   - The join-row INSERT runs in the SAME DB transaction as the tx
 *     INSERT so partial state can't be observed.
 *   - `invalidateUser(userId)` after commit.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { validateBody } from "@/lib/validate";
import { encryptField, tryDecryptField } from "@/lib/crypto/envelope";
import { decryptStaged } from "@/lib/crypto/staging-envelope";
import { invalidateUser } from "@/lib/mcp/user-tx-cache";
import { validateSignVsCategoryById } from "@/lib/transactions/sign-category-invariant";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  bankTransactionId: z.string().uuid(),
  categoryId: z.number().int().positive().optional(),
  accountId: z.number().int().positive().optional(),
});

export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = validateBody(body, bodySchema);
  if (parsed.error) return parsed.error;

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
        eq(schema.bankTransactions.id, parsed.data.bankTransactionId),
        eq(schema.bankTransactions.userId, userId),
      ),
    )
    .limit(1);
  if (!bankRow[0]) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const bank = bankRow[0];

  // Resolve target account. Default = bank row's account; override allowed
  // but ownership re-checked.
  const targetAccountId = parsed.data.accountId ?? bank.accountId;
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
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (acct[0].isInvestment) {
    // Investment accounts require a portfolio_holding_id on every tx
    // (CLAUDE.md "Investment-account constraint"). This surface doesn't
    // collect that; refuse cleanly and point the user at the manual flow.
    return NextResponse.json(
      {
        error:
          "Cannot materialize into an investment account from the reconcile surface. Use the manual transaction flow to select a holding.",
        code: "investment_account_unsupported",
      },
      { status: 400 },
    );
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
  if (parsed.data.categoryId != null) {
    const violation = await validateSignVsCategoryById(
      userId,
      dek,
      parsed.data.categoryId,
      bank.amount,
    );
    if (violation) {
      return NextResponse.json(
        {
          error: violation.message,
          code: "sign_category_mismatch",
        },
        { status: 400 },
      );
    }
  }

  // Cross-tenant FK guard on categoryId.
  if (parsed.data.categoryId != null) {
    const cat = await db
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(
        and(
          eq(schema.categories.id, parsed.data.categoryId),
          eq(schema.categories.userId, userId),
        ),
      )
      .limit(1);
    if (!cat[0]) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
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
        categoryId: parsed.data.categoryId ?? null,
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

  return NextResponse.json({ success: true, data: inserted });
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
