/**
 * Reconcile link write helpers (2026-05-23).
 *
 * Single chokepoint for INSERTs / DELETEs against `transaction_bank_links`.
 * The API routes at /api/reconcile/links delegate here so the dual-write
 * rule between the join table and the legacy `transactions.bank_transaction_id`
 * FK lives in one place.
 *
 * Invariants honored:
 *   - Every link write runs in a single DB transaction with the FK update
 *     so a partial state (join row inserted but FK not bumped) can't be
 *     observed mid-flight.
 *   - When a 'primary' join row is INSERTed AND the tx's FK is currently
 *     NULL, the FK is set in the same transaction. We never overwrite an
 *     existing non-NULL FK (the user might have linked through a different
 *     path first; that pointer is the source of truth).
 *   - When a 'primary' join row is DELETEd AND the tx's FK still pointed
 *     at that bank id, the FK is cleared in the same transaction.
 *   - `transactions.updated_at` is bumped whenever the FK transitions
 *     (audit-trio invariant, CLAUDE.md "Load-bearing gotchas").
 *   - `invalidateUser(userId)` is called after commit so the MCP per-user
 *     tx cache doesn't serve stale data.
 *   - "User edits always win" — the helpers NEVER modify
 *     transactions.{date,amount,payee,categoryId,note,tags}. Linking is
 *     structural; data stays as the user entered it.
 *   - Ownership: the caller MUST verify `transactionId` and
 *     `bankTransactionId` belong to `userId` before invoking these helpers.
 *     The helpers re-assert via the WHERE clauses for defense in depth.
 */

import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { invalidateUser } from "@/lib/mcp/user-tx-cache";
import type { TransactionSource } from "@/lib/tx-source";

export type LinkType = "primary" | "extra";

export interface LinkInput {
  userId: string;
  transactionId: number;
  bankTransactionId: string;
  linkType: LinkType;
  /** Writer-surface attribution. 'manual' for user-clicked accepts,
   *  'reconcile_link' for the materialize-from-bank-row path. */
  source: TransactionSource;
}

export interface LinkResult {
  linkId: number;
  /** True when the FK transactions.bank_transaction_id was set as part of
   *  this call (linkType='primary' and the FK was previously NULL). */
  setPrimaryFk: boolean;
  /** True when the (tx, bank) pair was already linked. The existing row's
   *  id is returned in `linkId`; no insert was performed. */
  alreadyLinked: boolean;
}

/**
 * Transactional core of {@link linkTransactionToBank}. Performs the ownership
 * check, same-account guard, idempotency check, INSERT, and (for primary
 * links) the FK bump — all inside ONE `db.transaction`. Does NOT invalidate
 * the per-user tx cache: callers own that so a batch can invalidate exactly
 * once. Throws {@link LinkError} on ownership / cross-account failures.
 *
 * Extracted (FINLYNQ-216, additive — the public `linkTransactionToBank`
 * contract below is byte-identical) so the bulk helper
 * {@link linkTransactionsToBank} can loop this core per pair (each its own
 * outermost transaction = a natural per-pair "savepoint": a failed pair rolls
 * back only its own tx, the rest commit) and call `invalidateUser` once.
 */
async function linkTransactionToBankCore(
  input: LinkInput,
): Promise<LinkResult> {
  return db.transaction(async (tx) => {
    // Verify ownership of both rows. Defense in depth — the API route
    // SHOULD have done this already, but if we're called from a future
    // surface that forgot, fail closed.
    const owns = await tx
      .select({
        txId: schema.transactions.id,
        txAccountId: schema.transactions.accountId,
        currentFk: schema.transactions.bankTransactionId,
        bankId: schema.bankTransactions.id,
        bankAccountId: schema.bankTransactions.accountId,
      })
      .from(schema.transactions)
      .leftJoin(
        schema.bankTransactions,
        and(
          eq(schema.bankTransactions.id, input.bankTransactionId),
          eq(schema.bankTransactions.userId, input.userId),
        ),
      )
      .where(
        and(
          eq(schema.transactions.id, input.transactionId),
          eq(schema.transactions.userId, input.userId),
        ),
      )
      .limit(1);

    const row = owns[0];
    if (!row) {
      throw new LinkError("not_found", "transaction not found for user");
    }
    if (!row.bankId) {
      throw new LinkError(
        "not_found",
        "bank_transaction not found for user",
      );
    }

    // Same-account guard (FINLYNQ-211). A transaction and the bank-ledger
    // row it links to MUST belong to the same account. The match engine only
    // ever SUGGESTS same-account pairs, so this guards purely against the raw
    // API / bulk / MCP `accept_reconcile_suggestion` paths, which previously
    // accepted any user-owned (tx, bank) pair. Without it, a transfer leg in
    // account A linked to a bank row in account B renders "linked" in A's
    // reconcile view even though A's own statement never matched it — the
    // reported symptom where a transfer's peer leg reads as already-reconciled.
    if (
      row.txAccountId != null &&
      row.bankAccountId != null &&
      row.txAccountId !== row.bankAccountId
    ) {
      throw new LinkError(
        "cross_account",
        "transaction and bank row belong to different accounts",
      );
    }

    // Existing link?
    const existing = await tx
      .select({ id: schema.transactionBankLinks.id })
      .from(schema.transactionBankLinks)
      .where(
        and(
          eq(
            schema.transactionBankLinks.transactionId,
            input.transactionId,
          ),
          eq(
            schema.transactionBankLinks.bankTransactionId,
            input.bankTransactionId,
          ),
        ),
      )
      .limit(1);

    if (existing[0]) {
      return {
        linkId: existing[0].id,
        setPrimaryFk: false,
        alreadyLinked: true,
      };
    }

    const inserted = await tx
      .insert(schema.transactionBankLinks)
      .values({
        userId: input.userId,
        transactionId: input.transactionId,
        bankTransactionId: input.bankTransactionId,
        linkType: input.linkType,
        source: input.source,
      })
      .returning({ id: schema.transactionBankLinks.id });

    let setPrimaryFk = false;
    if (input.linkType === "primary" && row.currentFk == null) {
      await tx
        .update(schema.transactions)
        .set({
          bankTransactionId: input.bankTransactionId,
          updatedAt: sql`NOW()`,
        })
        .where(
          and(
            eq(schema.transactions.id, input.transactionId),
            eq(schema.transactions.userId, input.userId),
            // Re-assert the NULL guard inside the transaction to avoid
            // racing a concurrent link from another surface.
            isNull(schema.transactions.bankTransactionId),
          ),
        );
      setPrimaryFk = true;
    }

    return {
      linkId: inserted[0].id,
      setPrimaryFk,
      alreadyLinked: false,
    };
  });
}

/**
 * Link a transaction to a bank-ledger row. Inserts a `transaction_bank_links`
 * row; if `linkType='primary'` AND the transaction's FK is currently NULL,
 * also sets `transactions.bank_transaction_id` and bumps `updated_at`.
 *
 * Idempotent: if the (tx, bank) pair is already in the join table, returns
 * the existing row's id without modifying anything. The caller can flip
 * `link_type` later via a dedicated UPDATE path if needed.
 */
export async function linkTransactionToBank(
  input: LinkInput,
): Promise<LinkResult> {
  const result = await linkTransactionToBankCore(input);
  invalidateUser(input.userId);
  return result;
}

/** One element of a {@link linkTransactionsToBank} batch. */
export interface BulkLinkPair {
  transactionId: number;
  bankTransactionId: string;
  linkType: LinkType;
}

/** Positional result for one {@link BulkLinkPair}. On success `error` is
 *  absent; on failure the link fields are null and `error` carries the
 *  human-readable reason (ownership / cross-account / unexpected). */
export interface BulkLinkResult {
  transactionId: number;
  bankTransactionId: string;
  linkId: number | null;
  setPrimaryFk: boolean;
  alreadyLinked: boolean;
  error?: string;
}

/**
 * Bulk-link many (tx, bank) pairs in a single MCP call (FINLYNQ-216).
 *
 * Each pair runs through {@link linkTransactionToBankCore} in its OWN
 * transaction, so a bad / cross-account / unknown id rolls back only that
 * pair and the rest still commit (partial commit — the per-pair "savepoint").
 * Results are POSITIONAL with `pairs` (result[i] ↔ pairs[i]). Idempotency is
 * inherited verbatim from the core: a re-submitted already-linked pair returns
 * `alreadyLinked:true` with no error and inserts no duplicate.
 *
 * `invalidateUser(userId)` is called EXACTLY ONCE after the loop (never
 * per-pair) so the per-user MCP tx cache is invalidated a single time for the
 * whole batch.
 */
export async function linkTransactionsToBank(
  userId: string,
  pairs: BulkLinkPair[],
  source: TransactionSource,
): Promise<BulkLinkResult[]> {
  const results: BulkLinkResult[] = [];
  for (const pair of pairs) {
    try {
      const r = await linkTransactionToBankCore({
        userId,
        transactionId: pair.transactionId,
        bankTransactionId: pair.bankTransactionId,
        linkType: pair.linkType,
        source,
      });
      results.push({
        transactionId: pair.transactionId,
        bankTransactionId: pair.bankTransactionId,
        linkId: r.linkId,
        setPrimaryFk: r.setPrimaryFk,
        alreadyLinked: r.alreadyLinked,
      });
    } catch (e) {
      const message =
        e instanceof LinkError
          ? e.code === "cross_account"
            ? "Transaction and bank row belong to different accounts; a transfer leg can only be linked to a bank row in its own account."
            : "Not found"
          : e instanceof Error
            ? e.message
            : "Unexpected error linking pair";
      results.push({
        transactionId: pair.transactionId,
        bankTransactionId: pair.bankTransactionId,
        linkId: null,
        setPrimaryFk: false,
        alreadyLinked: false,
        error: message,
      });
    }
  }
  // Exactly once after the batch — never per-pair (tc-4-invalidate-once).
  invalidateUser(userId);
  return results;
}

export interface UnlinkInput {
  userId: string;
  transactionId: number;
  bankTransactionId: string;
}

export interface UnlinkResult {
  unlinked: boolean;
  /** True when the FK transactions.bank_transaction_id was cleared as
   *  part of this call (the unlinked row was 'primary' and the FK still
   *  pointed at this bank id). */
  clearedFk: boolean;
}

/**
 * Remove a transaction ↔ bank-ledger link. Deletes the join row and, if it
 * was the primary AND the FK still points at the same bank id, clears the
 * FK + bumps `updated_at`. Idempotent — unlinking a pair that was never
 * linked returns `{ unlinked: false, clearedFk: false }`.
 */
export async function unlinkTransactionFromBank(
  input: UnlinkInput,
): Promise<UnlinkResult> {
  const result = await db.transaction(async (tx) => {
    const existing = await tx
      .select({
        id: schema.transactionBankLinks.id,
        linkType: schema.transactionBankLinks.linkType,
      })
      .from(schema.transactionBankLinks)
      .where(
        and(
          eq(schema.transactionBankLinks.userId, input.userId),
          eq(
            schema.transactionBankLinks.transactionId,
            input.transactionId,
          ),
          eq(
            schema.transactionBankLinks.bankTransactionId,
            input.bankTransactionId,
          ),
        ),
      )
      .limit(1);

    if (!existing[0]) {
      return { unlinked: false, clearedFk: false };
    }

    await tx
      .delete(schema.transactionBankLinks)
      .where(eq(schema.transactionBankLinks.id, existing[0].id));

    let clearedFk = false;
    if (existing[0].linkType === "primary") {
      // Only clear the FK if it still points at this bank id — a
      // concurrent re-link to a different bank row should win.
      const cleared = await tx
        .update(schema.transactions)
        .set({
          bankTransactionId: null,
          updatedAt: sql`NOW()`,
        })
        .where(
          and(
            eq(schema.transactions.id, input.transactionId),
            eq(schema.transactions.userId, input.userId),
            eq(
              schema.transactions.bankTransactionId,
              input.bankTransactionId,
            ),
          ),
        )
        .returning({ id: schema.transactions.id });
      clearedFk = cleared.length > 0;
    }

    return { unlinked: true, clearedFk };
  });

  invalidateUser(input.userId);
  return result;
}

/**
 * Structured error thrown by the link helpers when ownership / existence
 * checks fail. API routes catch and translate to 404 (consistent with the
 * rest of the staging surface — never 403, which would leak existence).
 */
export class LinkError extends Error {
  constructor(
    public code: "not_found" | "cross_account",
    message: string,
  ) {
    super(message);
    this.name = "LinkError";
  }
}

// Dual-write retrofit for import chokepoints (Phase 5 of the reconcile
// refactor, 2026-05-23). Every site that sets `transactions.bank_transaction_id`
// on a fresh INSERT must also insert a 'primary' row into
// `transaction_bank_links` so the reconcile page's read path stays in
// lockstep with the legacy FK. The pattern is small enough that each
// callsite inlines the INSERT against its own transaction/client handle
// (Drizzle tx + raw pg client both have to be supported), so there's no
// shared helper here — see the four retrofitted sites:
//   - src/lib/import-pipeline.ts          (executeImport)
//   - src/lib/transfer.ts                  (createTransferPair{,ViaSql})
//   - src/app/api/import/staged/[id]/approve/route.ts (peer-pair bucket)
//   - src/app/api/data/import/route.ts     (backup-restore)
// Format used everywhere:
//   INSERT INTO transaction_bank_links
//     (user_id, transaction_id, bank_transaction_id, link_type, source)
//   VALUES ($1, $2, $3, 'primary', $4)
//   ON CONFLICT (transaction_id, bank_transaction_id) DO NOTHING
// `$4` is 'import' for the four import chokepoints, 'backup_restore' for
// the restore path. The reconcile-page-driven 'manual' + 'reconcile_link'
// values are written through {@link linkTransactionToBank} above.

// Silence the unused-import lint for the `or` helper — kept on the import
// list because the v1 surface above doesn't need it, but the helper will
// pick it up when we add the "swap primary link in place" path.
void or;
