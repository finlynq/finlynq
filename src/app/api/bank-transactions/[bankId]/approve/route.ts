/**
 * POST /api/bank-transactions/[bankId]/approve (Inbox v4 Phase 3, 2026-05-27)
 *
 * Approve-each lens companion to /api/reconcile/materialize. Commits a
 * single bank-ledger row to the `transactions` ledger with a user-chosen
 * category. The new tx is linked to the bank row via a 'primary'
 * `transaction_bank_links` entry so the row stops being "bank-only" on
 * next /inbox refresh.
 *
 * Why a separate endpoint from /materialize?
 *   - Caller semantics differ: /materialize attributes `source='reconcile_link'`
 *     because the user reconciled inside the two-pane Manual surface.
 *     /approve attributes `source='manual'` because the user explicitly
 *     approved one card under the Approve-each lens (the policy IS the
 *     authoring intent — no separate "reconcile" step happened).
 *   - The Phase 4 /categorize endpoint (Auto-pilot unmatched rows) and
 *     this Phase 3 /approve endpoint will diverge: /categorize attributes
 *     `source='auto_rule'` for the rule-fired path and `source='manual'`
 *     for the user-clicked-categorize path.
 *   - Sharing /materialize would muddy the audit trail.
 *
 * The shape mirrors /materialize so the implementation can grow into a
 * shared helper once the third caller (Phase 4 /categorize) is in place.
 *
 * Request body (JSON) — EXACTLY ONE of categoryId / transferDestAccountId:
 *   {
 *     categoryId?:            number,   // commit a categorized tx
 *     transferDestAccountId?: number,   // commit a transfer pair (source leg
 *                                       //   on the bank row's account → dest).
 *                                       //   Outflow rows only; refuses
 *                                       //   inflow / self / investment-dest.
 *     payee?:      string,        // optional — overrides the bank row's payee
 *     accountId?:  number,        // optional — defaults to the bank row's account
 *                                 //   (categoryId path only; transfer source is
 *                                 //   always the bank row's account)
 *     linkType?:   'primary'      // ignored; primary is the only legal value here
 *   }
 *
 * Response:
 *   200  { success: true, data: { transactionId, warning? } }   — transactionId
 *                                 is the source leg id for the transfer path;
 *                                 `warning` = the sign is unusual for the
 *                                 category (booked anyway, 2026-10-15).
 *   400  { error, code? }   — validation / investment guard /
 *                             transfer guard (transfer_self / transfer_inflow /
 *                             transfer_investment_dest)
 *   404  { error: 'Not found' }   — bank row / account / category / transfer
 *                                   destination not owned by user
 *   423  { error: 'session_locked' }   — DEK unavailable
 *
 * Invariants honored (all per CLAUDE.md):
 *   - `requireEncryption` — writes the ledger, DEK required.
 *   - Cross-tenant 404 (never 403) on bank, account, category lookups.
 *   - `source='manual'` — present in the 9-value CHECK constraint
 *     (scripts/migrations/20260602_backfill_pipeline.sql:140).
 *   - `import_hash` copied VERBATIM from the bank row. Never recomputed —
 *     recomputing on a different payee creates a re-import gap.
 *   - `payee` re-encrypted under the user's DEK. `transactions` is user-tier
 *     only; the bank row's encryption_tier may be 'service' (email webhook)
 *     and we never preserve service-tier wrappings across materialization.
 *   - Sign-vs-category is ADVISORY: checked, returned as `warning`, never a
 *     refusal (a refund in an expense category is real money).
 *   - Investment-account guard — refuses materialization into an investment
 *     account (would need a portfolio_holding_id which this surface
 *     doesn't collect; Phase 3 covers non-investment accounts only).
 *   - Tx + link INSERTs share one DB transaction — no partial state.
 *   - `invalidateUser(userId)` after commit clears the per-user MCP tx
 *     cache so Claude doesn't read stale payees.
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
import { materializeBankRowAsTransfer } from "@/lib/reconcile/materialize-transfer";

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    // categoryId OR transferDestAccountId — exactly one (refine below).
    // categoryId commits a categorized tx; transferDestAccountId commits a
    // transfer pair (source leg on the bank row's account).
    categoryId: z.number().int().positive().optional(),
    transferDestAccountId: z.number().int().positive().optional(),
    payee: z.string().max(512).optional(),
    accountId: z.number().int().positive().optional(),
    linkType: z.literal("primary").optional(),
  })
  .refine(
    (b) =>
      (b.categoryId != null) !== (b.transferDestAccountId != null),
    {
      message:
        "Provide exactly one of categoryId or transferDestAccountId.",
      path: ["categoryId"],
    },
  );

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

  // Load + ownership-check the bank row in one query. Cross-tenant attacks
  // hit 404 here, never 403 — same pattern as /materialize and the rest of
  // the bank-ledger surface.
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

  // ─── Approve-as-transfer branch ──────────────────────────────────────────
  // When the request supplies `transferDestAccountId` (a transfer-only rule
  // matched this row), write a transfer pair through the shared materializer
  // instead of a categorized tx. Outflow rows only; the helper refuses
  // inflow / self / investment-dest with a typed code we map to a 400. The
  // categoryId path below is unchanged.
  if (parsed.data.transferDestAccountId != null) {
    const payeePlain = decodeBankString(bank.encryptionTier, dek, bank.payee);
    const result = await materializeBankRowAsTransfer({
      userId,
      dek,
      bank: {
        id: bank.id,
        accountId: bank.accountId,
        date: bank.date,
        amount: bank.amount,
        currency: bank.currency,
      },
      payeePlain: parsed.data.payee ?? payeePlain,
      destAccountId: parsed.data.transferDestAccountId,
      txSource: "manual",
    });
    if (!result.ok) {
      // transfer_dest_not_found is a cross-tenant / missing-account miss →
      // 404 (never 403) like the rest of the surface; everything else is a
      // client guard violation → 400 with the code.
      const status = result.code === "transfer_dest_not_found" ? 404 : 400;
      return NextResponse.json(
        { error: result.message, code: result.code },
        { status },
      );
    }
    return NextResponse.json({
      success: true,
      data: { transactionId: result.fromTransactionId },
    });
  }

  // From here on, the categoryId path. categoryId is guaranteed present by
  // the body schema's exactly-one refine.
  const categoryId = parsed.data.categoryId!;

  // Resolve target account. Default = bank row's account; override allowed
  // but ownership re-checked. Investment-account guard same as /materialize.
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
          "Cannot approve into an investment account from the inbox card surface. Switch the lens to Manual or open the portfolio operations flow to select a holding.",
        code: "investment_account_unsupported",
      },
      { status: 400 },
    );
  }

  // Sign-vs-category is a WARNING, never a refusal (2026-10-15, owner
  // request): a refund in an expense category or a reversal in an income one
  // is still booked, and the caller shows the message. The bank row's amount
  // is the source of truth; we never flip signs.
  const violation = await validateSignVsCategoryById(
    userId,
    dek,
    categoryId,
    bank.amount,
  );

  // Cross-tenant FK guard on categoryId.
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
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Decrypt the bank row's text columns tier-aware. The bank row may be
  // service-tier (email webhook) or user-tier (CSV upload); we always
  // re-encrypt under the user's DEK because `transactions` is user-tier
  // only.
  const payeeFromBank = decodeBankString(bank.encryptionTier, dek, bank.payee);
  const payeePlain = parsed.data.payee ?? payeeFromBank ?? "";
  const notePlain = decodeBankString(bank.encryptionTier, dek, bank.note);
  const tagsPlain = decodeBankString(bank.encryptionTier, dek, bank.tags);

  // INSERT both rows in a single DB transaction. invalidateUser fires
  // AFTER the commit returns so a partial-state cache update is impossible.
  const inserted = await db.transaction(async (tx) => {
    const txRow = await tx
      .insert(schema.transactions)
      .values({
        userId,
        date: bank.date,
        accountId: targetAccountId,
        categoryId,
        currency: bank.currency,
        amount: bank.amount,
        enteredCurrency: bank.enteredCurrency,
        enteredAmount: bank.enteredAmount,
        enteredFxRate: bank.enteredFxRate,
        quantity: bank.quantity,
        // Re-encrypt under user DEK. encryptField returns "" for empty
        // strings — matches the transactions table column nullability
        // (payee/note/tags default to "").
        payee: encryptField(dek, payeePlain) ?? "",
        note: encryptField(dek, notePlain) ?? "",
        tags: encryptField(dek, tagsPlain) ?? "",
        importHash: bank.importHash,
        fitId: bank.fitId,
        bankTransactionId: bank.id,
        // Approve-each policy attribution. Phase 4's /categorize endpoint
        // will use 'auto_rule' for the rule-fired path and 'manual' for
        // user-driven categorize. Here the user explicitly clicked Approve
        // on a single row → 'manual'.
        source: "manual",
        // createdAt + updatedAt + enteredAt all default to NOW() via the
        // column defaults — no need to set explicitly.
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

/**
 * Tier-aware decrypt for one of the encrypted-in-place text columns on
 * `bank_transactions`. Mirrors the pattern in
 * `pf-app/src/lib/reconcile/bank-ledger-pool.ts` `decryptBankPayee` and the
 * twin helper in /api/reconcile/materialize.
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
