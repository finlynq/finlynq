/**
 * sendStagedRowsToBankLedger — shared "promote staged rows into bank_transactions
 * ONLY" writer (FINLYNQ-220 / R-07).
 *
 * Extracted verbatim from the inline body of
 * `src/app/api/import/staged/[id]/approve/route.ts` (the import-modes Phase 3
 * bank-only promote route, 2026-05-25) so the web route AND the new
 * `send_to_bank_ledger` MCP tool share ONE chokepoint — mirrors the FINLYNQ-150
 * `materializeBankRowAsTransaction` pattern. Duplicating this in the MCP tool
 * would create two drift points and was the root cause of R-07: the MCP
 * `approve_staged_rows` tool still wrapped `executeImport` and wrote into the
 * `transactions` ledger, duplicating manual entries during statement imports.
 *
 * One job: promote the selected staged rows into `bank_transactions` and the
 * statement anchor into `bank_daily_balances`. NO `transactions` write, NO
 * `executeImport`, NO categorization gate, NO transfer-pair classification.
 * `/reconcile` is the single decision surface for categorization + linking.
 * (The one EXCEPTION — preserved verbatim from the route — is the legacy
 * `reconcile_state='linked'` branch, which inserts a `transaction_bank_links`
 * row pointing at a PRE-EXISTING tx; it NEVER creates a `transactions` row.)
 *
 * Load-bearing rules honored (CLAUDE.md / docs/invariants.md):
 *   - import_hash recomputed over PLAINTEXT payee with the resolved accountId
 *     (the upload classifier may hash with accountId=0). Mirrors the route.
 *   - Encryption tier per row branches at decode time; upsertBankTransaction
 *     re-encrypts payee/note/ticker/securityName at the row's tier.
 *   - Bank-ledger source = 'import' for the upload-staged + email-staged paths.
 *   - validateBankBalances stays — warn-but-allow on divergence.
 *   - Owner-scoped: staged_imports row must belong to userId AND be 'pending'.
 *
 * FINLYNQ-220 addition over the route's lifted logic: an opt-in
 * `skipExistingMatches` filter (default false for the route to stay
 * byte-identical; default true for the MCP tool) that drops rows already known
 * to the bank ledger (`dedup_status='existing'`) before the upsert loop, so a
 * statement re-import of mostly-known rows can load the anchor + only the new
 * rows.
 */

import { db, schema } from "@/db";
import { and, eq, asc, inArray, ne } from "drizzle-orm";
import { decryptStaged } from "@/lib/crypto/staging-envelope";
import { tryDecryptField } from "@/lib/crypto/envelope";
import {
  encryptStagingMeta,
  decryptStagingMeta,
} from "@/lib/crypto/staging-metadata";
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

export type SendToBankLedgerFailCode = "not_found";

export interface SendToBankLedgerInput {
  userId: string;
  /** User DEK — required to decrypt payee/note + re-encrypt at tier. */
  dek: Buffer;
  /** staged_imports.id */
  stagedImportId: string;
  /** Subset of staged_transactions.id to promote. Omit = all eligible. */
  rowIds?: string[];
  /**
   * Skip rows the importer already flagged as present in the bank ledger
   * (`dedup_status='existing'`). The web route passes `false` (preserves its
   * pre-FINLYNQ-220 behavior verbatim); the MCP tool defaults `true`.
   */
  skipExistingMatches?: boolean;
}

export interface SendToBankLedgerSuccess {
  ok: true;
  batchId: string;
  /** bank_transactions rows freshly inserted this call. */
  approved: number;
  /** Rows that hit an existing bank_transactions row (ON CONFLICT bumped). */
  skippedDuplicates: number;
  /**
   * Rows excluded UP FRONT by the `skipExistingMatches` filter
   * (dedup_status='existing'). Distinct from skippedDuplicates (upsert miss).
   */
  skippedExisting: number;
  /** Legacy reconcile_state='linked' rows that got a transaction_bank_links row. */
  legacyLinked: number;
  anchorsPromoted: number;
  /** True when at least one statement anchor was promoted. */
  anchorLoaded: boolean;
  /** First promoted anchor's date (or null). */
  anchorDate: string | null;
  /** First promoted anchor's balance (or null). */
  anchorAmount: number | null;
  balanceWarnings: BalanceMismatch[];
  rowErrors: Array<{ rowIndex: number; message: string }>;
  boundAccountId: number | null;
}

export type SendToBankLedgerResult =
  | SendToBankLedgerSuccess
  | { ok: false; code: SendToBankLedgerFailCode; message: string };

export async function sendStagedRowsToBankLedger(
  input: SendToBankLedgerInput,
): Promise<SendToBankLedgerResult> {
  const { userId, dek, stagedImportId: id } = input;
  const rowIds = input.rowIds;
  const skipExistingMatches = input.skipExistingMatches ?? false;

  // ─── Load staged_imports + verify ownership ──────────────────────────────
  const staged = await db
    .select({
      id: schema.stagedImports.id,
      source: schema.stagedImports.source,
      fileFormat: schema.stagedImports.fileFormat,
      originalFilename: schema.stagedImports.originalFilename,
      // FINLYNQ-120 — needed to tier-decrypt originalFilename (sv1: vs v1:).
      encryptionTier: schema.stagedImports.encryptionTier,
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
    return { ok: false, code: "not_found", message: "Not found or already processed" };
  }

  // FINLYNQ-120 — staged.originalFilename is now encrypted (sv1: service-tier
  // for email batches, v1: user-tier for uploads / post-sweep). Decrypt to
  // plaintext once.
  const plainFilename = decryptStagingMeta(
    staged.originalFilename,
    staged.encryptionTier,
    dek,
  );

  // ─── Load staged_transactions ────────────────────────────────────────────
  const allRows = await db
    .select()
    .from(schema.stagedTransactions)
    .where(eq(schema.stagedTransactions.stagedImportId, id))
    .orderBy(asc(schema.stagedTransactions.rowIndex))
    .all();

  // When rowIds omitted, default-exclude skipped_duplicate rows. When
  // rowIds is explicit, honor it verbatim (user picked).
  let allSelected = rowIds
    ? allRows.filter((r) => rowIds.includes(r.id))
    : allRows.filter((r) => r.reconcileState !== "skipped_duplicate");

  // FINLYNQ-220 — opt-in: drop rows already in the bank ledger before the
  // upsert loop. Counted separately from upsert-miss skippedDuplicates.
  let skippedExisting = 0;
  if (skipExistingMatches) {
    const before = allSelected.length;
    allSelected = allSelected.filter((r) => r.dedupStatus !== "existing");
    skippedExisting = before - allSelected.length;
  }

  // ─── Anchor preparation ──────────────────────────────────────────────────
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
    return { ok: false, code: "not_found", message: "No rows selected" };
  }

  // ─── Account lookup (case-insensitive across nameCt + aliasCt) ──────────
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
    ticker: string | null;
    securityName: string | null;
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

    // Recompute import_hash with the resolved accountId (mirrors the route).
    const importHash = generateImportHash(r.date, accountId, r.amount, payee);

    resolved.push({
      staged: r,
      accountId,
      payee,
      note,
      tags,
      accountName,
      ticker: decode(r.ticker, r.encryptionTier),
      securityName: decode(r.securityName, r.encryptionTier),
      importHash,
    });
  }

  // ─── Bank-balance pre-flight validation ──────────────────────────────────
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
  // Connector-staged imports (SimpleFIN etc.) keep 'connector' attribution end
  // to end; email/upload keep their labels. All three satisfy the
  // bank_upload_batches.source CHECK.
  const sourceLabel =
    staged.source === "connector"
      ? "connector"
      : staged.source === "email"
        ? "email"
        : "upload";
  const bankRowSource: "import" | "connector" =
    staged.source === "connector" ? "connector" : "import";
  const [batchRow] = await db
    .insert(schema.bankUploadBatches)
    .values({
      userId,
      accountId: staged.boundAccountId ?? resolved[0]?.accountId ?? 0,
      templateId: null,
      source: sourceLabel,
      mode: "detailed",
      filename: encryptStagingMeta(plainFilename, "user", dek),
      encryptionTier: "user",
      rowCount: resolved.length,
      anchorCount: dedupedAnchors.length,
      stagedImportId: staged.id,
    })
    .returning({ id: schema.bankUploadBatches.id });

  // ─── Upsert bank_transactions ────────────────────────────────────────────
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
        ticker: r.ticker,
        securityName: r.securityName,
        payee: r.payee,
        note: r.note,
        tags: r.tags,
        accountName: r.accountName,
        source: bankRowSource,
        filename: plainFilename,
        originalStagedImportId: staged.id,
        uploadBatchId: batchRow.id,
      });
      if (wasInserted) {
        approved += 1;
      } else {
        skippedDuplicates += 1;
      }

      // ─── Legacy 'linked' row preservation (NEVER writes a transactions row) ─
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
      console.error("[send-to-bank-ledger] anchor promotion failed", {
        userId,
        stagedImportId: staged.id,
        err,
      });
    }
  }

  // ─── Mark materialized rows imported (KEEP them) + maybe mark approved ──
  if (materializedRowIds.size > 0) {
    await db
      .update(schema.stagedTransactions)
      .set({ rowStatus: "approved" })
      .where(inArray(schema.stagedTransactions.id, Array.from(materializedRowIds)));
  }
  // If no rows still need action (every row is now 'approved'), mark the
  // import approved so it leaves the pending list.
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

  const firstAnchor = dedupedAnchors[0] ?? null;
  return {
    ok: true,
    batchId: batchRow.id,
    approved,
    skippedDuplicates,
    skippedExisting,
    legacyLinked,
    anchorsPromoted: dedupedAnchors.length,
    anchorLoaded: dedupedAnchors.length > 0,
    anchorDate: firstAnchor?.date ?? null,
    anchorAmount: firstAnchor?.balance ?? null,
    balanceWarnings,
    rowErrors,
    boundAccountId: staged.boundAccountId,
  };
}
