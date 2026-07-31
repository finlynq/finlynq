/**
 * "Is this staged statement finished?" — decided against the LIVE bank ledger,
 * not against the duplicate stamps recorded when the file arrived.
 *
 * WHY THIS IS LEDGER-BASED
 * ------------------------
 * Every staged row is stamped `new` or `skipped_duplicate` at ingest time by
 * probing `bank_transactions`. That stamp is then FROZEN — nothing recomputes
 * it (deliberately: CLAUDE.md's "do NOT silently flip skipped_duplicate back to
 * unmatched"). Two statements can therefore both be staged before either is
 * promoted, both stamp transaction X `new`, and after the first one promotes X
 * the second still claims X is outstanding. Re-reading stamps can never see
 * that; only re-probing the ledger can.
 *
 * So a row counts as resolved when ANY of:
 *   1. `row_status = 'approved'`            — promoted by this or a prior pass
 *   2. `reconcile_state = 'skipped_duplicate'` — flagged a duplicate at ingest
 *      (includes fuzzy hits, which is why we never need to re-run fuzzy here)
 *   3. its `import_hash` / `fit_id` is present in `bank_transactions` NOW —
 *      i.e. a sibling statement loaded it in the meantime
 *
 * EXACT MATCHING ONLY IN (3). The ingest probe also does a fuzzy amount/date
 * match, which can misfire. That is survivable at ingest because the row stays
 * visible for review; in a silent background sweep it is not — a false match
 * would close a statement holding a genuinely new transaction. Rows already
 * fuzzy-flagged at ingest still qualify under (2), so nothing regresses.
 *
 * ALL-OR-NOTHING. One unresolved row keeps the whole statement pending. This is
 * the guard that stops the sweep swallowing real data.
 */

import { db, schema, withDbTransaction } from "@/db";
import { and, eq, inArray, ne } from "drizzle-orm";
import {
  checkDuplicates,
  checkFitIdDuplicates,
  checkFitIdDuplicatesForAccount,
} from "@/lib/import-hash";
import { encryptStagingMeta, decryptStagingMeta } from "@/lib/crypto/staging-metadata";

/** A staged row reduced to the fields the resolution rule reads. */
export interface ResolutionRow {
  reconcileState: string;
  rowStatus: string;
}

/**
 * Conditions (1) and (2) only — the stamp-based half of the rule.
 *
 * Kept as its own pure predicate because it is the cheap pre-filter: rows it
 * accepts never need a ledger probe. Also the original FINLYNQ import fix, so
 * its unit tests still describe real behaviour.
 */
export function importFullyResolved(rows: readonly ResolutionRow[]): boolean {
  return rows.every((r) => rowResolvedByStamp(r));
}

/** True when a row is resolved without consulting the ledger. */
export function rowResolvedByStamp(r: ResolutionRow): boolean {
  return r.rowStatus === "approved" || r.reconcileState === "skipped_duplicate";
}

/**
 * Minimal executor so the app `db` proxy, a `tx` handle and the MCP `DbLike`
 * can all drive this. Mirrors the `Executor` shape in lib/delete-blockers.ts.
 */
export interface StatementRow {
  id: string;
  stagedImportId: string;
  importHash: string | null;
  fitId: string | null;
  reconcileState: string;
  rowStatus: string;
}

/**
 * Of the given staged imports, which are FULLY represented in the bank ledger?
 *
 * Set-based on purpose: the sibling sweep evaluates every pending statement for
 * an account in ONE pair of probe queries rather than one pair per statement.
 *
 * A statement with zero rows is never "finished" — an empty statement is an
 * anchor-only sync, which the promote path closes through its own anchor
 * branch; closing it here would race that.
 */
export async function statementsFullyInLedger(
  userId: string,
  stagedImportIds: string[],
): Promise<Set<string>> {
  const finished = new Set<string>();
  if (stagedImportIds.length === 0) return finished;

  const rows = (await db
    .select({
      id: schema.stagedTransactions.id,
      stagedImportId: schema.stagedTransactions.stagedImportId,
      importHash: schema.stagedTransactions.importHash,
      fitId: schema.stagedTransactions.fitId,
      reconcileState: schema.stagedTransactions.reconcileState,
      rowStatus: schema.stagedTransactions.rowStatus,
    })
    .from(schema.stagedTransactions)
    .where(inArray(schema.stagedTransactions.stagedImportId, stagedImportIds))
    .all()) as StatementRow[];

  if (rows.length === 0) return finished;

  // bound_account_id decides which fitId probe is correct (a bank transaction
  // id is unique only WITHIN an account — see checkFitIdDuplicatesForAccount).
  const imports = await db
    .select({
      id: schema.stagedImports.id,
      boundAccountId: schema.stagedImports.boundAccountId,
    })
    .from(schema.stagedImports)
    .where(inArray(schema.stagedImports.id, stagedImportIds))
    .all();
  const accountByImport = new Map<string, number | null>(
    imports.map((i) => [i.id, i.boundAccountId ?? null]),
  );

  const byImport = new Map<string, StatementRow[]>();
  for (const r of rows) {
    const list = byImport.get(r.stagedImportId);
    if (list) list.push(r);
    else byImport.set(r.stagedImportId, [r]);
  }

  // Only rows NOT already resolved by stamp need a ledger probe.
  const unstamped = rows.filter((r) => !rowResolvedByStamp(r));

  const hashes = Array.from(
    new Set(unstamped.map((r) => r.importHash).filter((h): h is string => !!h)),
  );
  const ledgerHashes = await checkDuplicates(hashes, userId);

  // fitIds are probed per bound account; group them so each account gets one
  // scoped query, and fall back to the user-scoped probe for unbound imports.
  const fitIdsByAccount = new Map<number | null, Set<string>>();
  for (const r of unstamped) {
    if (!r.fitId) continue;
    const acct = accountByImport.get(r.stagedImportId) ?? null;
    const set = fitIdsByAccount.get(acct);
    if (set) set.add(r.fitId);
    else fitIdsByAccount.set(acct, new Set([r.fitId]));
  }
  const ledgerFitIdsByAccount = new Map<number | null, Set<string>>();
  for (const [acct, set] of fitIdsByAccount) {
    const list = Array.from(set);
    const hits =
      acct != null
        ? await checkFitIdDuplicatesForAccount(list, userId, acct)
        : await checkFitIdDuplicates(list, userId);
    ledgerFitIdsByAccount.set(acct, hits);
  }

  for (const [importId, importRows] of byImport) {
    if (importRows.length === 0) continue;
    const acct = accountByImport.get(importId) ?? null;
    const ledgerFitIds = ledgerFitIdsByAccount.get(acct) ?? new Set<string>();
    const allResolved = importRows.every((r) => {
      if (rowResolvedByStamp(r)) return true;
      if (r.importHash && ledgerHashes.has(r.importHash)) return true;
      if (r.fitId && ledgerFitIds.has(r.fitId)) return true;
      return false;
    });
    if (allResolved) finished.add(importId);
  }

  return finished;
}

/**
 * File a finished statement into the PROCESSED bucket.
 *
 * Two writes, one transaction, because a statement marked done WITHOUT a batch
 * row is invisible in both lists — it leaves /import/pending and never appears
 * under "Loaded into the bank ledger", which is built from `bank_upload_batches`
 * and not from statement status. That was the defect in the first version of
 * this fix: 24 of the 26 duplicate-only statements on dev had no batch.
 *
 * Idempotent — safe to call twice, and safe under two concurrent syncs for the
 * same account.
 */
export async function finishStatement(
  userId: string,
  stagedImportId: string,
  dek: Buffer | null,
): Promise<boolean> {
  const staged = await db
    .select({
      id: schema.stagedImports.id,
      source: schema.stagedImports.source,
      status: schema.stagedImports.status,
      boundAccountId: schema.stagedImports.boundAccountId,
      originalFilename: schema.stagedImports.originalFilename,
      encryptionTier: schema.stagedImports.encryptionTier,
    })
    .from(schema.stagedImports)
    .where(
      and(
        eq(schema.stagedImports.id, stagedImportId),
        eq(schema.stagedImports.userId, userId),
      ),
    )
    .get();
  if (!staged) return false;

  // bank_upload_batches.account_id is NOT NULL, so an unbound statement (a
  // cross-account CSV) cannot be filed into Processed. Leave it pending rather
  // than inventing an account — those are never pure-duplicate feeds anyway.
  if (staged.boundAccountId == null) return false;

  const existing = await db
    .select({ id: schema.bankUploadBatches.id })
    .from(schema.bankUploadBatches)
    .where(
      and(
        eq(schema.bankUploadBatches.userId, userId),
        eq(schema.bankUploadBatches.stagedImportId, stagedImportId),
      ),
    )
    .get();

  const plainFilename = decryptStagingMeta(
    staged.originalFilename,
    staged.encryptionTier,
    dek,
  );
  const sourceLabel =
    staged.source === "connector" ? "connector" : staged.source === "email" ? "email" : "upload";

  await withDbTransaction(async () => {
    if (!existing) {
      await db.insert(schema.bankUploadBatches).values({
        userId,
        accountId: staged.boundAccountId as number,
        templateId: null,
        source: sourceLabel,
        mode: "detailed",
        filename: encryptStagingMeta(plainFilename, "user", dek),
        encryptionTier: "user",
        // Zero rows and zero anchors is the marker: nothing was loaded because
        // everything was already in the ledger. A future retention policy can
        // target exactly these.
        rowCount: 0,
        anchorCount: 0,
        stagedImportId,
      });
    }
    await db
      .update(schema.stagedImports)
      .set({ status: "approved" })
      .where(eq(schema.stagedImports.id, stagedImportId));
  });

  return true;
}

/**
 * Close the statement if — and only if — the ledger already contains all of it.
 * The single entry point used by both exits of `sendStagedRowsToBankLedger`.
 */
export async function finishStatementIfFullyInLedger(
  userId: string,
  stagedImportId: string,
  dek: Buffer | null,
): Promise<boolean> {
  const finished = await statementsFullyInLedger(userId, [stagedImportId]);
  if (!finished.has(stagedImportId)) return false;
  return finishStatement(userId, stagedImportId, dek);
}

/**
 * After a statement is processed, re-check the OTHER pending statements for the
 * same account: one of them may have been fully absorbed by what just landed.
 *
 * This is the half that the stamp-based rule structurally could not do. Scoped
 * to one account, one set of probe queries, and it returns immediately when the
 * account has nothing pending — which is the common case and costs one query.
 *
 * NON-RECURSIVE BY CONSTRUCTION: it calls `finishStatement` directly and never
 * re-enters `sendStagedRowsToBankLedger`. Closing a statement loads nothing
 * into the ledger, so a statement closed here cannot create work for another
 * pass. Do not "simplify" this into a call back through the promote path.
 */
export async function sweepPendingStatementsForAccount(
  userId: string,
  accountId: number,
  dek: Buffer | null,
  excludeStagedImportId?: string,
): Promise<string[]> {
  const where = [
    eq(schema.stagedImports.userId, userId),
    eq(schema.stagedImports.boundAccountId, accountId),
    eq(schema.stagedImports.status, "pending"),
  ];
  if (excludeStagedImportId) {
    where.push(ne(schema.stagedImports.id, excludeStagedImportId));
  }

  const pending = await db
    .select({ id: schema.stagedImports.id })
    .from(schema.stagedImports)
    .where(and(...where))
    .all();
  if (pending.length === 0) return [];

  const finished = await statementsFullyInLedger(
    userId,
    pending.map((p) => p.id),
  );
  const closed: string[] = [];
  for (const id of finished) {
    if (await finishStatement(userId, id, dek)) closed.push(id);
  }
  return closed;
}
