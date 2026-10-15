/**
 * POST /api/bank-transactions/[bankId]/categorize (Inbox v4 Phase 4, 2026-05-27)
 *
 * Auto-pilot lens companion to /api/bank-transactions/[bankId]/approve.
 * Commits a single bank-ledger row that DIDN'T match any auto-rule to the
 * `transactions` ledger with a user-chosen category. The new tx is linked
 * to the bank row via a 'primary' `transaction_bank_links` entry so the
 * row stops being "bank-only" on next /inbox refresh.
 *
 * The semantic distinction vs /approve:
 *   - /approve is the Approve-each lens action: bank rows wait for the
 *     user's one-click approval; suggestion is informational; user picks
 *     the category from the suggestion or via the dialog. Source='manual'.
 *   - /categorize is the Auto-pilot lens action: bank rows that DID NOT
 *     match any rule fall through to the "To categorize" tab. The user
 *     manually picks a category. Source='manual' (this is a deliberate
 *     user click, not a rule fire — kept 'manual' so the audit trail
 *     distinguishes hand-categorized rows from rule-matched rows. Phase 4
 *     uses 'auto_rule' ONLY for upload-time-fired rules in
 *     `applyRulesToBankRows`).
 *
 * Request body (JSON):
 *   {
 *     categoryId: number,        // required
 *     payee?:     string,        // optional — overrides the bank row's payee
 *     accountId?: number,        // optional — defaults to the bank row's account
 *   }
 *
 * Response:
 *   200  { success: true, data: { transactionId, warning? } }   — `warning` =
 *        the sign is unusual for the category (booked anyway, 2026-10-15)
 *   400  { error, code? }   — validation / investment guard
 *   404  { error: 'Not found' }   — bank row, account, or category not owned by user
 *   423  { error: 'session_locked' }   — DEK unavailable
 *
 * Same invariants honored as /approve (CLAUDE.md):
 *   - requireEncryption (writes the ledger, DEK required)
 *   - Cross-tenant 404 (never 403)
 *   - source='manual' — present in the 10-value CHECK constraint
 *     (scripts/migrations/20260527_transactions_source_auto_rule.sql)
 *   - import_hash copied VERBATIM from the bank row
 *   - payee re-encrypted under the user's DEK
 *   - sign-vs-category is ADVISORY: returned as `warning`, never a refusal
 *   - investment-account guard refuses cleanly
 *   - tx + link INSERT in one DB transaction
 *   - invalidateUser(userId) after commit
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
  categoryId: z.number().int().positive(),
  payee: z.string().max(512).optional(),
  accountId: z.number().int().positive().optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ bankId: string }> },
) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;

  const { bankId } = await params;
  if (!bankId) {
    return NextResponse.json({ error: "Missing bankId" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = validateBody(body, bodySchema);
  if (parsed.error) return parsed.error;

  // Cross-tenant guard via the userId filter.
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
        eq(schema.bankTransactions.id, bankId),
        eq(schema.bankTransactions.userId, userId),
      ),
    )
    .limit(1);
  if (!bankRow[0]) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const bank = bankRow[0];

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
    return NextResponse.json(
      {
        error:
          "Cannot categorize into an investment account from the inbox card surface. Switch the lens to Manual or open the portfolio operations flow to select a holding.",
        code: "investment_account_unsupported",
      },
      { status: 400 },
    );
  }

  // Advisory only (2026-10-15): a suggestion lands here precisely when a
  // rule's category didn't match the sign, so refusing made it unbookable.
  const violation = await validateSignVsCategoryById(
    userId,
    dek,
    parsed.data.categoryId,
    bank.amount,
  );

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

  const payeeFromBank = decodeBankString(bank.encryptionTier, dek, bank.payee);
  const payeePlain = parsed.data.payee ?? payeeFromBank ?? "";
  const notePlain = decodeBankString(bank.encryptionTier, dek, bank.note);
  const tagsPlain = decodeBankString(bank.encryptionTier, dek, bank.tags);

  const inserted = await db.transaction(async (tx) => {
    const txRow = await tx
      .insert(schema.transactions)
      .values({
        userId,
        date: bank.date,
        accountId: targetAccountId,
        categoryId: parsed.data.categoryId,
        currency: bank.currency,
        amount: bank.amount,
        enteredCurrency: bank.enteredCurrency,
        enteredAmount: bank.enteredAmount,
        enteredFxRate: bank.enteredFxRate,
        quantity: bank.quantity,
        payee: encryptField(dek, payeePlain) ?? "",
        note: encryptField(dek, notePlain) ?? "",
        tags: encryptField(dek, tagsPlain) ?? "",
        importHash: bank.importHash,
        fitId: bank.fitId,
        bankTransactionId: bank.id,
        // Auto-pilot UNMATCHED → user manually categorized. Distinct from
        // /approve's 'manual' only by semantic context (the row went
        // through "To categorize", not "To approve"). Both surfaces stamp
        // 'manual' because the user explicitly picked the category.
        source: "manual",
      })
      .returning({ id: schema.transactions.id });

    await tx.insert(schema.transactionBankLinks).values({
      userId,
      transactionId: txRow[0].id,
      bankTransactionId: bank.id,
      linkType: "primary",
      source: "manual",
    });

    return { transactionId: txRow[0].id };
  });

  invalidateUser(userId);

  return NextResponse.json({
    success: true,
    data: { ...inserted, ...(violation ? { warning: violation.message } : {}) },
  });
}

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
