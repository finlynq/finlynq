/**
 * PATCH /api/import/staged/[id]/rows/[rowId]
 *
 * Edit a single staged transaction row in place before approval. Issue #155.
 *
 * The review UI uses this for: type/category/payee/note/tags edits, holding
 * + quantity selection on investment-account rows, transfer-pair linking
 * (peer_staged_id sibling OR target_account_id destination), and cross-
 * currency entered_amount/entered_currency overrides.
 *
 * Encryption: re-encrypts payee/category/account_name/note under the row's
 * EXISTING tier — service-tier rows stay sv1: under PF_STAGING_KEY, user-tier
 * rows stay v1: under the user's DEK. We never flip a row's tier mid-edit.
 *
 * Load-bearing rules (CLAUDE.md):
 *   - `import_hash` is computed at ingest from plaintext payee and is
 *     NEVER recomputed by edits (load-bearing for cross-source dedup).
 *     Editing payee in staging means the row no longer matches the ingest-
 *     time hash; that's the accepted tradeoff — the bank-side dedup runs
 *     against what the bank sent us, not what the user retitled it to.
 *   - peer_staged_id and target_account_id are mutually exclusive
 *     (a transfer can't both pair with a staging sibling AND mint a new
 *     destination leg). The PATCH rejects when both are set.
 *   - peer_staged_id MUST belong to the same user AND same staged_import.
 *   - portfolio_holding_id MUST belong to the same user.
 *   - target_account_id MUST belong to the same user.
 *   - tx_type ∈ {'E','I','R'} (CHECK constraint in SQL).
 *   - Cross-tenant attacks return 404 — same shape as the rest of the
 *     staging API surface.
 *
 * Returns the updated row with decrypted display fields (matching the GET
 * endpoint's tier-branched decode).
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { decryptStaged, encryptStaged } from "@/lib/crypto/staging-envelope";
import { tryDecryptField, encryptField } from "@/lib/crypto/envelope";

export const dynamic = "force-dynamic";

const PatchSchema = z.object({
  txType: z.enum(["E", "I", "R"]).optional(),
  payee: z.string().max(2000).optional(),
  category: z.string().max(2000).optional(),
  note: z.string().max(2000).optional(),
  tags: z.string().max(2000).optional(),
  quantity: z.number().nullable().optional(),
  portfolioHoldingId: z.number().int().nullable().optional(),
  enteredAmount: z.number().nullable().optional(),
  enteredCurrency: z.string().max(8).nullable().optional(),
  peerStagedId: z.string().nullable().optional(),
  targetAccountId: z.number().int().nullable().optional(),
  // Reserved for the partial-approve flow that overrides
  // dedup_status='probable_duplicate' rows. Accepted but currently a no-op
  // here — the approve endpoint enforces dedup behavior, this PATCH only
  // mutates user-edited fields.
  forceCommit: z.boolean().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; rowId: string }> },
) {
  // requireEncryption — payee/category/note edits on user-tier rows
  // re-encrypt under the user's DEK. Service-tier rows still need a logged-
  // in user (we don't re-encrypt under PF_STAGING_KEY without auth context).
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;
  const { id, rowId } = await params;

  let body: z.infer<typeof PatchSchema>;
  try {
    const json = await request.json();
    body = PatchSchema.parse(json);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof z.ZodError ? e.issues[0]?.message ?? "Invalid body" : "Invalid JSON" },
      { status: 400 },
    );
  }

  // Verify the staged_import belongs to this user. Cross-tenant attacks
  // return 404 here without leaking that the import id exists for someone
  // else.
  const staged = await db
    .select({ id: schema.stagedImports.id, status: schema.stagedImports.status })
    .from(schema.stagedImports)
    .where(and(
      eq(schema.stagedImports.id, id),
      eq(schema.stagedImports.userId, userId),
    ))
    .get();
  if (!staged) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (staged.status !== "pending") {
    return NextResponse.json(
      { error: "Staged import is not pending — edits are no longer accepted" },
      { status: 409 },
    );
  }

  // Verify the row belongs to this user AND staged_import. user_id filter
  // is the cross-tenant guard; staged_import_id keeps an attacker from
  // editing a row in a different import they happen to know the id of.
  const row = await db
    .select()
    .from(schema.stagedTransactions)
    .where(and(
      eq(schema.stagedTransactions.id, rowId),
      eq(schema.stagedTransactions.userId, userId),
      eq(schema.stagedTransactions.stagedImportId, id),
    ))
    .get();
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Build the update set, validating ownership / mutual exclusion as we go.
  const update: Record<string, unknown> = {};

  if (body.txType !== undefined) update.txType = body.txType;
  if (body.quantity !== undefined) update.quantity = body.quantity;
  if (body.enteredAmount !== undefined) update.enteredAmount = body.enteredAmount;
  if (body.enteredCurrency !== undefined) {
    update.enteredCurrency = body.enteredCurrency
      ? body.enteredCurrency.toUpperCase()
      : null;
  }

  // Mutual exclusion of peer_staged_id and target_account_id. We read both
  // the existing values AND the incoming patch; if the patch ends up with
  // both set after merging, reject.
  const peerAfter =
    body.peerStagedId !== undefined ? body.peerStagedId : row.peerStagedId;
  const targetAfter =
    body.targetAccountId !== undefined ? body.targetAccountId : row.targetAccountId;
  if (peerAfter != null && targetAfter != null) {
    return NextResponse.json(
      { error: "peer_staged_id and target_account_id are mutually exclusive" },
      { status: 400 },
    );
  }

  if (body.peerStagedId !== undefined) {
    if (body.peerStagedId == null) {
      update.peerStagedId = null;
    } else {
      // Peer must belong to the same user AND same staged_import.
      const peer = await db
        .select({ id: schema.stagedTransactions.id })
        .from(schema.stagedTransactions)
        .where(and(
          eq(schema.stagedTransactions.id, body.peerStagedId),
          eq(schema.stagedTransactions.userId, userId),
          eq(schema.stagedTransactions.stagedImportId, id),
        ))
        .get();
      if (!peer) {
        return NextResponse.json(
          { error: "peer_staged_id not found" },
          { status: 404 },
        );
      }
      if (peer.id === row.id) {
        return NextResponse.json(
          { error: "peer_staged_id cannot point at the same row" },
          { status: 400 },
        );
      }
      update.peerStagedId = body.peerStagedId;
    }
  }

  if (body.targetAccountId !== undefined) {
    if (body.targetAccountId == null) {
      update.targetAccountId = null;
    } else {
      const acct = await db
        .select({ id: schema.accounts.id })
        .from(schema.accounts)
        .where(and(
          eq(schema.accounts.id, body.targetAccountId),
          eq(schema.accounts.userId, userId),
        ))
        .get();
      if (!acct) {
        return NextResponse.json(
          { error: "target_account_id not found" },
          { status: 404 },
        );
      }
      update.targetAccountId = body.targetAccountId;
    }
  }

  if (body.portfolioHoldingId !== undefined) {
    if (body.portfolioHoldingId == null) {
      update.portfolioHoldingId = null;
    } else {
      const holding = await db
        .select({ id: schema.portfolioHoldings.id })
        .from(schema.portfolioHoldings)
        .where(and(
          eq(schema.portfolioHoldings.id, body.portfolioHoldingId),
          eq(schema.portfolioHoldings.userId, userId),
        ))
        .get();
      if (!holding) {
        return NextResponse.json(
          { error: "portfolio_holding_id not found" },
          { status: 404 },
        );
      }
      update.portfolioHoldingId = body.portfolioHoldingId;
    }
  }

  // Re-encrypt edited text fields under the row's EXISTING tier.
  // service tier → encryptStaged (sv1: under PF_STAGING_KEY)
  // user tier    → encryptField (v1: under user DEK)
  // We never flip the tier mid-edit; the login-time upgrade job is the
  // only path that promotes service → user. Per CLAUDE.md:
  //   "Staged-transactions reads MUST branch on encryption_tier per row;
  //    Mixed tiers within the same staged_imports batch are expected
  //    mid-upgrade."
  const encrypt = (v: string | null | undefined): string | null => {
    if (v == null) return null;
    return row.encryptionTier === "user"
      ? encryptField(dek, v)
      : encryptStaged(v);
  };

  if (body.payee !== undefined) update.payee = encrypt(body.payee);
  if (body.category !== undefined) update.category = encrypt(body.category);
  if (body.note !== undefined) update.note = encrypt(body.note);
  // tags is a free-text comma-separated value — NOT encrypted at staging
  // time today (staged_transactions.tags is plaintext, mirroring how
  // the upload route ingests it). The approve endpoint encrypts under
  // DEK at materialize-into-`transactions` time.
  if (body.tags !== undefined) update.tags = body.tags;

  if (Object.keys(update).length === 0) {
    // Nothing to do — return the row as-is for client convenience.
    return NextResponse.json({ ok: true, row: shapeRowResponse(row, dek) });
  }

  // CLAUDE.md: "import_hash is NEVER recomputed on edit." We deliberately
  // do NOT touch row.importHash here even when payee was edited. Cross-
  // source dedup keys on the ingest-time hash; rewriting it here would
  // create a window where the row would silently match a different
  // existing transaction or fail to match a re-ingestion.
  await db
    .update(schema.stagedTransactions)
    .set(update)
    .where(and(
      eq(schema.stagedTransactions.id, rowId),
      eq(schema.stagedTransactions.userId, userId),
    ));

  // Return the new row (re-read so we have the updated values + decrypt
  // for display).
  const updated = await db
    .select()
    .from(schema.stagedTransactions)
    .where(eq(schema.stagedTransactions.id, rowId))
    .get();
  if (!updated) {
    // Race window — should be impossible since we hold the row above,
    // but surface a clean error rather than throwing.
    return NextResponse.json({ error: "Row vanished after update" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, row: shapeRowResponse(updated, dek) });
}

/** Shape a staged_transactions row for the API response with decrypted
 *  display fields. Mirrors the GET endpoint's per-row tier branching. */
function shapeRowResponse(
  row: typeof schema.stagedTransactions.$inferSelect,
  dek: Buffer,
) {
  const decode = (v: string | null): string | null => {
    if (v == null) return null;
    return row.encryptionTier === "user"
      ? tryDecryptField(dek, v)
      : decryptStaged(v);
  };
  return {
    id: row.id,
    date: row.date,
    amount: row.amount,
    currency: row.currency,
    payee: decode(row.payee),
    category: decode(row.category),
    accountName: decode(row.accountName),
    note: decode(row.note),
    rowIndex: row.rowIndex,
    isDuplicate: row.isDuplicate,
    encryptionTier: row.encryptionTier,
    dedupStatus: row.dedupStatus,
    rowStatus: row.rowStatus,
    txType: row.txType,
    quantity: row.quantity,
    portfolioHoldingId: row.portfolioHoldingId,
    enteredAmount: row.enteredAmount,
    enteredCurrency: row.enteredCurrency,
    tags: row.tags,
    fitId: row.fitId,
    peerStagedId: row.peerStagedId,
    targetAccountId: row.targetAccountId,
  };
}
