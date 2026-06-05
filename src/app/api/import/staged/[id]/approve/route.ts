/**
 * POST /api/import/staged/[id]/approve
 *
 * Phase 3 of import-modes refactor (2026-05-25). Per
 * [plan/import-modes-simplified-detailed.md](../../../../../plan/import-modes-simplified-detailed.md).
 *
 * Approve is now a one-job route: promote the selected staged rows into
 * `bank_transactions`. No more categorization gate, no transactions write,
 * no transaction_bank_links insert, no transfer-pair classification, no
 * executeImport. `/reconcile` is the single decision surface for
 * categorization + linking + transfer pairing.
 *
 * Body (all optional):
 *   {
 *     "rowIds":             string[]   // subset of staged_transactions.id; omit = all eligible
 *   }
 *
 * Behavior:
 *   - Loads staged_imports + verifies ownership + status='pending'.
 *   - Loads staged_transactions (filtered by rowIds when provided; otherwise
 *     auto-excludes reconcile_state='skipped_duplicate').
 *   - Resolves accountId per row from staged_imports.boundAccountId, falling
 *     back to a decoded-accountName lookup (case-insensitive across nameCt
 *     + aliasCt). Rows without a resolvable account surface as per-row
 *     errors and are skipped.
 *   - Decrypts payee/note/tags/accountName per encryption_tier.
 *   - Computes occurrence_index per (account_id, import_hash) group for
 *     same-batch collisions.
 *   - Creates ONE bank_upload_batches row up front so every bank_transactions
 *     row stamps the lineage FK.
 *   - Calls upsertBankTransaction per row — the canonical writer handles
 *     dedup (ON CONFLICT bumps last_seen_at + seen_count) and tier-aware
 *     encryption.
 *   - For legacy rows with reconcileState='linked' AND linkedTransactionId
 *     set: ALSO inserts a transaction_bank_links primary row pointing at
 *     the existing tx so the bank row is wired to the user's ledger row.
 *     (Pre-Phase-3 'linked' staged rows preserve their lineage; the new
 *     UI no longer exposes this workflow.)
 *   - Promotes anchors via upsertBankBalanceAnchors with the new batch id.
 *   - Marks each materialized staged_transactions row row_status='approved'
 *     and KEEPS it (2026-06-05). The rows stay on the staging review's file
 *     side, highlighted as "imported", instead of vanishing — and the
 *     "Loaded into the bank ledger" click re-opens this same review for the
 *     batch. Re-sending is safe: imported rows are excluded from the approve
 *     selection client-side, and upsertBankTransaction is idempotent.
 *   - Marks staged_imports.status='approved' only once NO row remains with
 *     row_status != 'approved' (so a fully-sent import leaves the pending
 *     list while its rows persist for re-opening).
 *
 * Returns:
 *   { success, batchId, approved, skippedDuplicates, legacyLinked,
 *     anchorsPromoted, balanceWarnings, redirectTo, rowErrors }
 *
 * Load-bearing rules (CLAUDE.md):
 *   - import_hash over PLAINTEXT payee — recomputed via generateImportHash
 *     when the staged row's stored hash was computed without an accountId
 *     (accountId=0 hash from upload classifier). Otherwise preserved verbatim.
 *   - Encryption tier per row branches at decode time.
 *   - Bank-ledger sources strict subset: this writer uses 'import' for
 *     upload-staged + email-staged paths.
 *   - validateBankBalances stays — warn-but-allow on divergence.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, eq, asc, inArray, ne } from "drizzle-orm";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { decryptStaged } from "@/lib/crypto/staging-envelope";
import { tryDecryptField } from "@/lib/crypto/envelope";
import { generateImportHash } from "@/lib/import-hash";
import { upsertBankTransaction } from "@/lib/bank-ledger";
import {
  validateBankBalances,
  upsertBankBalanceAnchors,
  type BalanceAnchor,
  type BalanceMismatch,
  ANCHOR_SOURCES,
  type AnchorSource,
} from "@/lib/bank-ledger-balance";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;
  const { id } = await params;

  // Body is optional — default = approve everything eligible.
  let rowIds: string[] | undefined;
  try {
    const body = await request.json() as { rowIds?: unknown };
    if (Array.isArray(body.rowIds)) {
      rowIds = body.rowIds.filter((x): x is string => typeof x === "string");
    }
  } catch {
    // no body / invalid JSON → approve everything
  }

  // ─── Load staged_imports + verify ownership ──────────────────────────────
  const staged = await db
    .select({
      id: schema.stagedImports.id,
      source: schema.stagedImports.source,
      fileFormat: schema.stagedImports.fileFormat,
      originalFilename: schema.stagedImports.originalFilename,
      boundAccountId: schema.stagedImports.boundAccountId,
      parsedAnchors: schema.stagedImports.parsedAnchors,
      statementBalance: schema.stagedImports.statementBalance,
      statementBalanceDate: schema.stagedImports.statementBalanceDate,
      statementCurrency: schema.stagedImports.statementCurrency,
    })
    .from(schema.stagedImports)
    .where(and(
      eq(schema.stagedImports.id, id),
      eq(schema.stagedImports.userId, userId),
      eq(schema.stagedImports.status, "pending"),
    ))
    .get();
  if (!staged) {
    return NextResponse.json({ error: "Not found or already processed" }, { status: 404 });
  }

  // ─── Load staged_transactions ────────────────────────────────────────────
  const allRows = await db
    .select()
    .from(schema.stagedTransactions)
    .where(eq(schema.stagedTransactions.stagedImportId, id))
    .orderBy(asc(schema.stagedTransactions.rowIndex))
    .all();

  // When rowIds omitted, default-exclude skipped_duplicate rows. When
  // rowIds is explicit, honor it verbatim (user picked).
  const allSelected = rowIds
    ? allRows.filter((r) => rowIds!.includes(r.id))
    : allRows.filter((r) => r.reconcileState !== "skipped_duplicate");

  // ─── Anchor preparation ──────────────────────────────────────────────────
  // Anchors collected from parsedAnchors JSONB + upload-form statement
  // balance. Promoted to bank_daily_balances at the end of the batch.
  const balanceAnchors: BalanceAnchor[] = [];
  if (staged.boundAccountId != null) {
    const parsed = staged.parsedAnchors;
    if (Array.isArray(parsed)) {
      for (const raw of parsed as unknown[]) {
        if (!raw || typeof raw !== "object") continue;
        const a = raw as Record<string, unknown>;
        if (typeof a.date !== "string") continue;
        if (typeof a.balance !== "number") continue;
        const ccy = typeof a.currency === "string" ? a.currency : "CAD";
        const src = typeof a.source === "string" ? a.source : "csv_column";
        if (!(ANCHOR_SOURCES as readonly string[]).includes(src)) continue;
        balanceAnchors.push({
          date: a.date,
          balance: a.balance,
          currency: ccy,
          source: src as AnchorSource,
        });
      }
    }
    if (
      typeof staged.statementBalance === "number" &&
      typeof staged.statementBalanceDate === "string"
    ) {
      balanceAnchors.push({
        date: staged.statementBalanceDate,
        balance: staged.statementBalance,
        currency: staged.statementCurrency ?? "CAD",
        source: "upload_form",
      });
    }
  }
  // De-dup anchors per-date, preferring upload_form when both exist.
  const anchorByDate = new Map<string, BalanceAnchor>();
  for (const a of balanceAnchors) {
    const existing = anchorByDate.get(a.date);
    if (!existing || existing.source === "upload_form") {
      anchorByDate.set(a.date, a);
    }
  }
  const dedupedAnchors = Array.from(anchorByDate.values());

  const anchorsOnlyApprove =
    staged.boundAccountId != null && dedupedAnchors.length > 0;

  if (allSelected.length === 0 && !anchorsOnlyApprove) {
    return NextResponse.json({ error: "No rows selected" }, { status: 400 });
  }

  // ─── Account lookup (case-insensitive across nameCt + aliasCt) ──────────
  // Same shape as the legacy approve route — the boundAccount path is the
  // common case; per-row accountName lookup is the multi-account-CSV path.
  type LiveAccount = {
    id: number;
    nameKey: string | null;
    aliasKey: string | null;
  };
  const accountRows = await db
    .select({
      id: schema.accounts.id,
      nameCt: schema.accounts.nameCt,
      aliasCt: schema.accounts.aliasCt,
    })
    .from(schema.accounts)
    .where(eq(schema.accounts.userId, userId))
    .all();
  const liveAccounts: LiveAccount[] = accountRows.map((a) => {
    const plainName = a.nameCt ? tryDecryptField(dek, a.nameCt, "accounts.name_ct") : null;
    const plainAlias = a.aliasCt ? tryDecryptField(dek, a.aliasCt, "accounts.alias_ct") : null;
    return {
      id: a.id,
      nameKey: plainName ? plainName.toLowerCase().trim() : null,
      aliasKey: plainAlias ? plainAlias.toLowerCase().trim() : null,
    };
  });
  const lookupAccountId = (decodedName: string): number | null => {
    const key = decodedName.toLowerCase().trim();
    if (!key) return null;
    return (
      liveAccounts.find((a) => a.nameKey === key)?.id ??
      liveAccounts.find((a) => a.aliasKey === key)?.id ??
      null
    );
  };

  // ─── Decode + resolve each row ───────────────────────────────────────────
  const decode = (value: string | null, tier: string): string | null => {
    if (value == null) return null;
    return tier === "user" ? tryDecryptField(dek, value) : decryptStaged(value);
  };

  type ResolvedRow = {
    staged: typeof allRows[number];
    accountId: number;
    payee: string;
    note: string | null;
    tags: string | null;
    accountName: string | null;
    importHash: string;
  };
  const resolved: ResolvedRow[] = [];
  const rowErrors: Array<{ rowIndex: number; message: string }> = [];

  for (const r of allSelected) {
    let accountId: number | null = staged.boundAccountId;
    if (accountId == null) {
      const decodedName = decode(r.accountName, r.encryptionTier);
      if (decodedName) {
        accountId = lookupAccountId(decodedName);
      }
      if (accountId == null) {
        rowErrors.push({
          rowIndex: r.rowIndex,
          message: `Row ${r.rowIndex + 1}: account name "${decodedName ?? "(missing)"}" not found.`,
        });
        continue;
      }
    }
    const payee = decode(r.payee, r.encryptionTier) ?? "";
    const note = decode(r.note, r.encryptionTier);
    const tags = r.tags ?? null;
    const accountName = decode(r.accountName, r.encryptionTier);

    // Recompute import_hash with the resolved accountId. The upload
    // classifier hashes with accountId=0 when the column couldn't be
    // resolved at parse time — we need the real account-bound hash for
    // bank_transactions dedup. Mirrors the legacy approve route's logic
    // at lines 680-681 + 884-889.
    const importHash = generateImportHash(r.date, accountId, r.amount, payee);

    resolved.push({
      staged: r,
      accountId,
      payee,
      note,
      tags,
      accountName,
      importHash,
    });
  }

  // ─── Bank-balance pre-flight validation ──────────────────────────────────
  // Same shape as before — warn-but-allow on divergence (load-bearing).
  const projectedBankRows = resolved
    .filter((r) => staged.boundAccountId != null && r.accountId === staged.boundAccountId)
    .map((r) => ({ date: r.staged.date, amount: r.staged.amount }));
  let balanceWarnings: BalanceMismatch[] = [];
  if (staged.boundAccountId != null && dedupedAnchors.length > 0) {
    balanceWarnings = await validateBankBalances(
      userId,
      staged.boundAccountId,
      dedupedAnchors,
      projectedBankRows,
    );
  }

  // ─── Create the upload-batch row up front ────────────────────────────────
  // Phase 1 of import-modes refactor (2026-05-25). Anchors the Recent
  // Uploads panel + Phase 4 batch undo.
  const sourceLabel = staged.source === "email" ? "email" : "upload";
  const [batchRow] = await db
    .insert(schema.bankUploadBatches)
    .values({
      userId,
      // boundAccountId may be NULL for multi-account uploads; the panel
      // shows them as "various accounts". For the FK we have to pick one
      // — fall back to the first resolved row's accountId so the partial
      // index stays satisfied, OR if neither, skip writing a batch row.
      accountId: staged.boundAccountId ?? resolved[0]?.accountId ?? 0,
      templateId: null,
      source: sourceLabel,
      mode: "detailed",
      filename: staged.originalFilename ?? null,
      rowCount: resolved.length,
      anchorCount: dedupedAnchors.length,
      stagedImportId: staged.id,
    })
    .returning({ id: schema.bankUploadBatches.id });

  // ─── Upsert bank_transactions ────────────────────────────────────────────
  // Per-(accountId, importHash) occurrence_index assignment — same-batch
  // collisions get 0, 1, 2, … so each distinct row lands as its own ledger
  // entry.
  const occCounts = new Map<string, number>();
  let approved = 0;
  let skippedDuplicates = 0;
  let legacyLinked = 0;
  const materializedRowIds = new Set<string>();

  for (const r of resolved) {
    const occKey = `${r.accountId}:${r.importHash}`;
    const occ = occCounts.get(occKey) ?? 0;
    occCounts.set(occKey, occ + 1);

    try {
      const { id: bankTxId, wasInserted } = await upsertBankTransaction(dek, {
        userId,
        accountId: r.accountId,
        importHash: r.importHash,
        occurrenceIndex: occ,
        fitId: r.staged.fitId ?? null,
        date: r.staged.date,
        amount: r.staged.amount,
        currency: (r.staged.currency ?? "CAD").toUpperCase(),
        enteredAmount: r.staged.enteredAmount ?? null,
        enteredCurrency: r.staged.enteredCurrency ?? null,
        quantity: r.staged.quantity ?? null,
        payee: r.payee,
        note: r.note,
        tags: r.tags,
        accountName: r.accountName,
        source: "import",
        filename: staged.originalFilename ?? null,
        originalStagedImportId: staged.id,
        uploadBatchId: batchRow.id,
      });
      if (wasInserted) {
        approved += 1;
      } else {
        skippedDuplicates += 1;
      }

      // ─── Legacy 'linked' row preservation ────────────────────────────
      // Pre-Phase-3 'linked' staged rows (user pre-linked to existing tx
      // via the removed UI) still get a transaction_bank_links primary
      // row written so the bank entry wires to the user's ledger row.
      // The new UI no longer exposes this workflow; this branch only
      // fires for legacy in-flight data.
      if (
        r.staged.reconcileState === "linked" &&
        r.staged.linkedTransactionId != null
      ) {
        try {
          await db
            .insert(schema.transactionBankLinks)
            .values({
              userId,
              transactionId: r.staged.linkedTransactionId,
              bankTransactionId: bankTxId,
              linkType: "primary",
              source: "import",
            })
            .onConflictDoNothing({
              target: [
                schema.transactionBankLinks.transactionId,
                schema.transactionBankLinks.bankTransactionId,
              ],
            });
          legacyLinked += 1;
        } catch (linkErr) {
          rowErrors.push({
            rowIndex: r.staged.rowIndex,
            message: `Row ${r.staged.rowIndex + 1}: bank-link insert failed (${linkErr instanceof Error ? linkErr.message : "Unknown error"})`,
          });
        }
      }

      materializedRowIds.add(r.staged.id);
    } catch (err) {
      rowErrors.push({
        rowIndex: r.staged.rowIndex,
        message: `Row ${r.staged.rowIndex + 1}: bank-ledger upsert failed (${err instanceof Error ? err.message : "Unknown error"})`,
      });
    }
  }

  // ─── Promote anchors with batch lineage ──────────────────────────────────
  if (staged.boundAccountId != null && dedupedAnchors.length > 0) {
    try {
      await upsertBankBalanceAnchors(
        userId,
        staged.boundAccountId,
        dedupedAnchors,
        staged.originalFilename ?? null,
        batchRow.id,
      );
    } catch (err) {
      // Anchor errors are non-fatal — bank ledger rows already landed.
      // eslint-disable-next-line no-console
      console.error("[approve] anchor promotion failed", { userId, stagedImportId: staged.id, err });
    }
  }

  // ─── Mark materialized rows imported (KEEP them) + maybe mark approved ──
  //
  // 2026-06-05: materialized rows are no longer DELETED. They're flipped to
  // row_status='approved' and KEPT so the staged two-pane review keeps showing
  // them on the file (right) side — highlighted as "imported" — instead of
  // vanishing. The user (or the "Loaded into the bank ledger" click) re-opens
  // the same review screen and sees what was pushed. Re-sending is safe: these
  // rows are excluded from the approve selection client-side, and
  // upsertBankTransaction is idempotent (ON CONFLICT) if one slips through.
  if (materializedRowIds.size > 0) {
    await db
      .update(schema.stagedTransactions)
      .set({ rowStatus: "approved" })
      .where(inArray(schema.stagedTransactions.id, Array.from(materializedRowIds)));
  }
  // If no rows still need action (every row is now 'approved'), mark the
  // import approved so it leaves the pending list. Rows are kept either way
  // — an 'approved' import still carries its imported staged_transactions so
  // the review screen can be re-opened from the Loaded section. Skipped /
  // failed rows keep row_status='pending', so the batch stays pending until
  // the user resolves them.
  const remaining = await db
    .select({ id: schema.stagedTransactions.id })
    .from(schema.stagedTransactions)
    .where(and(
      eq(schema.stagedTransactions.stagedImportId, id),
      ne(schema.stagedTransactions.rowStatus, "approved"),
    ))
    .limit(1)
    .all();
  if (remaining.length === 0) {
    await db
      .update(schema.stagedImports)
      .set({ status: "approved" })
      .where(eq(schema.stagedImports.id, id));
  }

  // ─── Response ────────────────────────────────────────────────────────────
  return NextResponse.json({
    success: true,
    batchId: batchRow.id,
    approved,
    skippedDuplicates,
    legacyLinked,
    anchorsPromoted: dedupedAnchors.length,
    balanceWarnings,
    rowErrors,
    redirectTo: staged.boundAccountId != null
      ? `/reconcile?account=${staged.boundAccountId}`
      : "/reconcile",
  });
}
