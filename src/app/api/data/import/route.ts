import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { encryptField, isEncrypted } from "@/lib/crypto/envelope";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { safeErrorMessage } from "@/lib/validate";
import { coerceSourceForRestore } from "@/lib/tx-source";

type Row = Record<string, unknown>;

/**
 * Encrypt any plaintext on the named fields with the user's DEK. Rows that
 * already carry `v1:` ciphertext pass through (same-account restore). A
 * backup from a different account would be unreadable in both cases.
 */
function encryptRowFields(dek: Buffer, row: Row, fields: readonly string[]): Row {
  const out = { ...row };
  for (const f of fields) {
    const v = out[f];
    if (typeof v === "string" && v !== "" && !isEncrypted(v)) {
      out[f] = encryptField(dek, v);
    }
  }
  return out;
}

const TX_ENC_FIELDS = ["payee", "note", "tags", "portfolio_holding", "portfolioHolding"] as const;
const SPLIT_ENC_FIELDS = ["note", "description", "tags"] as const;

interface BackupData {
  version: string;
  exportedAt: string;
  appVersion?: string;
  data: {
    accounts?: Row[];
    categories?: Row[];
    transactions?: Row[];
    transactionSplits?: Row[];
    portfolioHoldings?: Row[];
    /** Two-ledger refactor (2026-05-22) — bank-side persistent ledger. */
    bankTransactions?: Row[];
    /** Phase 4 of import-modes refactor (2026-05-25) — upload batch lineage.
     *  Restored BEFORE bank_transactions so the upload_batch_id FK target
     *  exists during the per-row insert + remap. */
    bankUploadBatches?: Row[];
    budgets?: Row[];
    budgetTemplates?: Row[];
    loans?: Row[];
    goals?: Row[];
    goalAccounts?: Row[]; // issue #130 — multi-account goal join rows
    snapshots?: Row[];
    targetAllocations?: Row[];
    recurringTransactions?: Row[];
    subscriptions?: Row[];
    transactionRules?: Row[];
    importTemplates?: Row[];
    fxRates?: Row[];     // legacy backups (pre-2026-04-27) — ignored on import
    fxOverrides?: Row[]; // current backups
    settings?: Row[];
    contributionRoom?: Row[];
  };
}

/**
 * Strip auto-increment `id` and force `userId` onto every row, AND remap any
 * `accountId` / `categoryId` / `assignCategoryId` FK columns through the
 * caller-supplied IdMaps.
 *
 * Why the remap: a backup carries the source DB's account/category integer
 * IDs. When restored into the same DB under a different user, those raw IDs
 * may collide with rows belonging to other users — silently writing
 * cross-tenant FK references (data leak / wipe-blocker / privacy bug).
 *
 * Throws on an unmapped FK rather than passing the raw id through. That makes
 * the restore fail loudly so the user knows the backup is corrupt or the
 * accounts/categories sections were stripped out, instead of silently
 * inserting cross-tenant rows.
 */
function strip(
  rows: Row[] | undefined,
  userId: string,
  remap: {
    accountIdMap?: Map<number, number>;
    categoryIdMap?: Map<number, number>;
    goalIdMap?: Map<number, number>;
    // FINLYNQ-55 — remaps `staged_transactions.linkedTransactionId` (and any
    // future restore-target that carries a `linkedTransactionId` FK into
    // `transactions`) through the old→new id map built when transactions
    // are re-inserted earlier in the restore flow. Pre-migration backups
    // (column absent) fall through the `hasOwnProperty` guard and land
    // with the column's DB default ('unmatched' / NULL).
    transactionIdMap?: Map<number, number>;
  } = {},
): Row[] {
  return (rows ?? []).map((row) => {
    const { id: _id, userId: _uid, ...rest } = row;
    const out: Row = { ...rest, userId };

    if (remap.accountIdMap && Object.prototype.hasOwnProperty.call(rest, "accountId")) {
      const oldId = (rest as { accountId: unknown }).accountId;
      if (oldId === null || oldId === undefined) {
        out.accountId = null;
      } else {
        const newId = remap.accountIdMap.get(oldId as number);
        if (newId == null) {
          throw new Error(
            `Backup references unknown accountId=${String(oldId)} — accounts section missing or inconsistent`,
          );
        }
        out.accountId = newId;
      }
    }

    // Issue #130 — goal_accounts.goal_id remap. The join table is the only
    // restore consumer of this map today.
    if (remap.goalIdMap && Object.prototype.hasOwnProperty.call(rest, "goalId")) {
      const oldId = (rest as { goalId: unknown }).goalId;
      if (oldId === null || oldId === undefined) {
        throw new Error("goal_accounts row missing goalId");
      }
      const newId = remap.goalIdMap.get(oldId as number);
      if (newId == null) {
        throw new Error(
          `Backup references unknown goalId=${String(oldId)} — goals section missing or inconsistent`,
        );
      }
      out.goalId = newId;
    }

    if (remap.categoryIdMap && Object.prototype.hasOwnProperty.call(rest, "categoryId")) {
      const oldId = (rest as { categoryId: unknown }).categoryId;
      if (oldId === null || oldId === undefined) {
        out.categoryId = null;
      } else {
        const newId = remap.categoryIdMap.get(oldId as number);
        if (newId == null) {
          throw new Error(
            `Backup references unknown categoryId=${String(oldId)} — categories section missing or inconsistent`,
          );
        }
        out.categoryId = newId;
      }
    }

    // transaction_rules uses `assignCategoryId` (set-category action) — same
    // remap rule, different field name.
    if (remap.categoryIdMap && Object.prototype.hasOwnProperty.call(rest, "assignCategoryId")) {
      const oldId = (rest as { assignCategoryId: unknown }).assignCategoryId;
      if (oldId === null || oldId === undefined) {
        out.assignCategoryId = null;
      } else {
        const newId = remap.categoryIdMap.get(oldId as number);
        if (newId == null) {
          throw new Error(
            `Backup references unknown assignCategoryId=${String(oldId)} — categories section missing or inconsistent`,
          );
        }
        out.assignCategoryId = newId;
      }
    }

    // FINLYNQ-55 — staged_transactions.linkedTransactionId FK into the
    // restored `transactions` table. Same cross-tenant risk pattern as
    // accountId/categoryId — silently writing the source-DB integer id
    // would land the FK on whichever tenant's transactions.id happens to
    // match. Unmapped FK is a soft drop (null out) rather than a hard
    // throw because the user may have selected the link before the
    // referenced transaction was filtered out of the backup; the staging
    // row stays useful with reconcile_state preserved.
    if (
      remap.transactionIdMap &&
      Object.prototype.hasOwnProperty.call(rest, "linkedTransactionId")
    ) {
      const oldId = (rest as { linkedTransactionId: unknown }).linkedTransactionId;
      if (oldId === null || oldId === undefined) {
        out.linkedTransactionId = null;
      } else {
        const newId = remap.transactionIdMap.get(oldId as number);
        out.linkedTransactionId = newId ?? null;
      }
    }

    return out;
  });
}

const MAX_BODY_BYTES = 20 * 1024 * 1024; // 20 MB
const MAX_TRANSACTIONS = 50_000;

export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;

  // Reject oversized bodies early based on advertised Content-Length.
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: `Request body exceeds ${MAX_BODY_BYTES} byte limit` },
      { status: 413 }
    );
  }

  let body: { backup: BackupData; confirm?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { backup, confirm = false } = body;

  if (!backup?.version || !backup?.data) {
    return NextResponse.json(
      { error: "Invalid backup format — missing version or data" },
      { status: 400 }
    );
  }

  const d = backup.data;

  // Cap per-import row counts on the table that grows fastest.
  const txCount = d.transactions?.length ?? 0;
  const splitCount = d.transactionSplits?.length ?? 0;
  if (txCount > MAX_TRANSACTIONS || splitCount > MAX_TRANSACTIONS) {
    return NextResponse.json(
      {
        error: `Import exceeds ${MAX_TRANSACTIONS} transaction limit (got ${Math.max(
          txCount,
          splitCount
        )})`,
      },
      { status: 422 }
    );
  }

  const preview = {
    accounts: d.accounts?.length ?? 0,
    categories: d.categories?.length ?? 0,
    transactions: d.transactions?.length ?? 0,
    transactionSplits: d.transactionSplits?.length ?? 0,
    portfolioHoldings: d.portfolioHoldings?.length ?? 0,
    budgets: d.budgets?.length ?? 0,
    budgetTemplates: d.budgetTemplates?.length ?? 0,
    loans: d.loans?.length ?? 0,
    goals: d.goals?.length ?? 0,
    goalAccounts: d.goalAccounts?.length ?? 0,
    snapshots: d.snapshots?.length ?? 0,
    targetAllocations: d.targetAllocations?.length ?? 0,
    recurringTransactions: d.recurringTransactions?.length ?? 0,
    subscriptions: d.subscriptions?.length ?? 0,
    transactionRules: d.transactionRules?.length ?? 0,
    importTemplates: d.importTemplates?.length ?? 0,
    fxOverrides: d.fxOverrides?.length ?? d.fxRates?.length ?? 0,
    settings: d.settings?.length ?? 0,
    contributionRoom: d.contributionRoom?.length ?? 0,
  };

  if (!confirm) {
    return NextResponse.json({
      preview,
      exportedAt: backup.exportedAt,
      version: backup.version,
    });
  }

  try {
    // Delete existing data in FK-safe order
    await db.delete(schema.notifications).where(eq(schema.notifications.userId, userId));
    await db.delete(schema.subscriptions).where(eq(schema.subscriptions.userId, userId));
    await db.delete(schema.recurringTransactions).where(eq(schema.recurringTransactions.userId, userId));
    await db.delete(schema.contributionRoom).where(eq(schema.contributionRoom.userId, userId));
    // priceCache and fxRates are global shared caches — not part of per-user
    // backup/restore. User-specific FX pins live in fxOverrides.
    await db.delete(schema.fxOverrides).where(eq(schema.fxOverrides.userId, userId));
    await db.delete(schema.targetAllocations).where(eq(schema.targetAllocations.userId, userId));
    await db.delete(schema.snapshots).where(eq(schema.snapshots.userId, userId));
    // Issue #130 — explicit goal_accounts wipe before goals. ON DELETE
    // CASCADE on goal_accounts.goal_id would also handle this, but explicit
    // sequencing keeps the wipe predictable inside the single-transaction
    // flow.
    await db.delete(schema.goalAccounts).where(eq(schema.goalAccounts.userId, userId));
    await db.delete(schema.goals).where(eq(schema.goals.userId, userId));
    await db.delete(schema.loans).where(eq(schema.loans.userId, userId));
    await db.delete(schema.budgets).where(eq(schema.budgets.userId, userId));
    await db.delete(schema.budgetTemplates).where(eq(schema.budgetTemplates.userId, userId));
    await db.delete(schema.transactionRules).where(eq(schema.transactionRules.userId, userId));
    await db.delete(schema.importTemplates).where(eq(schema.importTemplates.userId, userId));

    const existingTxns = await db
      .select({ id: schema.transactions.id })
      .from(schema.transactions)
      .where(eq(schema.transactions.userId, userId));
    if (existingTxns.length > 0) {
      await db
        .delete(schema.transactionSplits)
        .where(inArray(schema.transactionSplits.transactionId, existingTxns.map((t) => t.id)))
        ;
    }

    await db.delete(schema.transactions).where(eq(schema.transactions.userId, userId));
    // Two-ledger refactor (2026-05-22) — delete bank_transactions AFTER
    // transactions since `transactions.bank_transaction_id` has ON DELETE
    // SET NULL; deleting transactions first leaves the bank-ledger rows
    // unreferenced, then the user_id-scoped delete drops them cleanly.
    await db.delete(schema.bankTransactions).where(eq(schema.bankTransactions.userId, userId));
    // Phase 4 of import-modes refactor (2026-05-25) — drop the lineage
    // table after bank_transactions to keep FK ordering trivial (the FK
    // is ON DELETE SET NULL so either order works, but this is clearer).
    await db.delete(schema.bankUploadBatches).where(eq(schema.bankUploadBatches.userId, userId));
    await db.delete(schema.portfolioHoldings).where(eq(schema.portfolioHoldings.userId, userId));
    await db.delete(schema.categories).where(eq(schema.categories.userId, userId));
    await db.delete(schema.accounts).where(eq(schema.accounts.userId, userId));

    // Insert accounts, build old→new ID map
    const accountIdMap = new Map<number, number>();
    if (d.accounts?.length) {
      // Reconcile v4 Phase 1 (2026-05-27) — coerce unknown/missing `mode` values
      // back to 'manual' so a pre-Phase-1 backup (column absent) or a corrupt
      // value doesn't hit the CHECK constraint on insert.
      const ACCOUNT_MODES = new Set(["auto", "approve", "manual"]);
      const stripped = strip(d.accounts, userId).map((row) => {
        const raw = (row as { mode?: unknown }).mode;
        (row as { mode: string }).mode =
          typeof raw === "string" && ACCOUNT_MODES.has(raw) ? raw : "manual";
        return row;
      });
      const inserted = await db
        .insert(schema.accounts)
        .values(stripped as (typeof schema.accounts.$inferInsert)[])
        .returning({ id: schema.accounts.id });
      d.accounts.forEach((old, i) => {
        if (inserted[i]) accountIdMap.set(old.id as number, inserted[i].id);
      });
    }

    // Insert categories, build old→new ID map
    const categoryIdMap = new Map<number, number>();
    if (d.categories?.length) {
      const inserted = await db
        .insert(schema.categories)
        .values(strip(d.categories, userId) as (typeof schema.categories.$inferInsert)[])
        .returning({ id: schema.categories.id });
      d.categories.forEach((old, i) => {
        if (inserted[i]) categoryIdMap.set(old.id as number, inserted[i].id);
      });
    }

    if (d.portfolioHoldings?.length) {
      // Issue #205 — capture inserted ids so we can dual-write the matching
      // holding_accounts pairings. Every aggregator (issue #25) JOINs through
      // holding_accounts on (holding_id, account_id, user_id); an inserted
      // holding without that pairing is silently invisible to the portfolio
      // page, get_portfolio_analysis, etc.
      const stripped = strip(d.portfolioHoldings, userId, { accountIdMap }) as (typeof schema.portfolioHoldings.$inferInsert)[];
      const insertedHoldings = await db
        .insert(schema.portfolioHoldings)
        .values(stripped)
        .returning({ id: schema.portfolioHoldings.id, accountId: schema.portfolioHoldings.accountId });

      // Bulk-insert holding_accounts using the freshly-RETURNING-ed ids and
      // the already-remapped accountIds. Skip rows where accountId is null
      // (no pairing target). is_primary=true mirrors the legacy
      // portfolio_holdings.account_id column. qty=0/cost_basis=0 are CACHED
      // defaults — aggregators read live values from transactions.
      const haRows = insertedHoldings
        .filter((h): h is { id: number; accountId: number } => h.accountId != null)
        .map((h) => ({
          holdingId: h.id,
          accountId: h.accountId,
          userId,
          qty: 0,
          costBasis: 0,
          isPrimary: true,
        }));
      if (haRows.length > 0) {
        await db.insert(schema.holdingAccounts).values(haRows).onConflictDoNothing();
      }
    }

    // Phase 4 of import-modes refactor (2026-05-25) — restore
    // bank_upload_batches BEFORE bank_transactions so the upload_batch_id
    // FK target exists when bank_transactions inserts get remapped.
    const bankUploadBatchIdMap = new Map<string, string>();
    if (d.bankUploadBatches?.length) {
      const BATCH_SOURCES = new Set(["upload", "email", "connector"]);
      const BATCH_MODES = new Set(["simplified", "detailed"]);
      const remappedBatches = d.bankUploadBatches
        .map((row) => {
          const { id: _id, userId: _uid, accountId, source: rawSrc, mode: rawMode, templateId: _tpl, stagedImportId: _si, filename: rawFilename, encryptionTier: _tier, ...rest } = row;
          if (accountId == null) return null;
          const newAccountId = accountIdMap.get(accountId as number);
          if (newAccountId == null) {
            throw new Error(
              `Backup bank_upload_batches references unknown accountId=${String(accountId)} — accounts section missing or inconsistent`,
            );
          }
          const src = typeof rawSrc === "string" && BATCH_SOURCES.has(rawSrc) ? rawSrc : "upload";
          const mode = typeof rawMode === "string" && BATCH_MODES.has(rawMode) ? rawMode : "detailed";
          return {
            ...rest,
            userId,
            accountId: newAccountId,
            source: src,
            mode,
            // FINLYNQ-120 - the backup ships filename as plaintext (export
            // decrypts it). Re-encrypt under the restoring user's DEK and force
            // user-tier, mirroring the bank_transactions restore below.
            filename:
              typeof rawFilename === "string" ? encryptField(dek, rawFilename) : null,
            encryptionTier: "user",
            // template_id + staged_import_id are SET NULL on delete; we
            // drop them entirely on restore since template ids drift and
            // staged_imports rows aren't part of the backup payload today.
            templateId: null,
            stagedImportId: null,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);
      if (remappedBatches.length > 0) {
        const inserted = await db
          .insert(schema.bankUploadBatches)
          .values(remappedBatches as (typeof schema.bankUploadBatches.$inferInsert)[])
          .returning({ id: schema.bankUploadBatches.id });
        let outIdx = 0;
        for (const old of d.bankUploadBatches) {
          if (old.accountId == null) continue;
          if (inserted[outIdx]) {
            bankUploadBatchIdMap.set(String(old.id), inserted[outIdx].id as string);
          }
          outIdx++;
        }
      }
    }

    // Two-ledger refactor (2026-05-22) — restore bank_transactions BEFORE
    // transactions so the FK target exists when transactions.bank_transaction_id
    // is remapped through the bankTxIdMap below. Per-row remap mirrors the
    // transactions pattern: accountId is required (NULL would break the
    // unique index per CLAUDE.md "account_id precondition"), payee/note/tags/
    // account_name re-encrypt under user DEK, source coerces to the bank-
    // ledger subset of TransactionSource. UUIDs are remapped (gen_random_uuid()
    // default in the migration will assign fresh ones via .returning()).
    const bankTxIdMap = new Map<string, string>();
    if (d.bankTransactions?.length) {
      const BANK_LEDGER_SOURCES_RESTORE = new Set(["import", "connector", "backup_restore"]);
      // FINLYNQ-195 — ticker + securityName are investment-import capture columns
      // exported as plaintext; re-encrypt under the restoring user's DEK like
      // payee/note/tags/accountName.
      const BANK_TX_ENC_FIELDS = ["payee", "note", "tags", "accountName", "ticker", "securityName"] as const;
      const remapped = d.bankTransactions
        .map((row) => {
          const { id: _id, userId: _uid, accountId, source: rawSource, uploadBatchId: rawBatchId, ...rest } = row;
          if (accountId == null) return null;
          const newAccountId = accountIdMap.get(accountId as number);
          if (newAccountId == null) {
            throw new Error(
              `Backup bank_transactions references unknown accountId=${String(accountId)} — accounts section missing or inconsistent`,
            );
          }
          const src =
            typeof rawSource === "string" && BANK_LEDGER_SOURCES_RESTORE.has(rawSource)
              ? rawSource
              : "backup_restore";
          // Phase 4 (2026-05-25) — remap upload_batch_id through the
          // batch-id map built above. Missing map entry → NULL (the FK
          // is ON DELETE SET NULL so this is the same end state as if
          // the batch was deleted).
          const newBatchId =
            typeof rawBatchId === "string" && bankUploadBatchIdMap.has(rawBatchId)
              ? bankUploadBatchIdMap.get(rawBatchId)!
              : null;
          // FINLYNQ-132 — source_filenames ships as PLAINTEXT in the portable
          // export (decrypted by the export route for cross-DEK portability).
          // Re-encrypt each element under the local user DEK so it lands at
          // rest as v1: ciphertext, matching the forced encryption_tier='user'.
          // A same-account backup may already carry v1: ciphertext; isEncrypted
          // guards against double-wrapping. Null/non-string elements are dropped.
          const rawFilenames = (rest as { sourceFilenames?: unknown }).sourceFilenames;
          const reEncFilenames: string[] = Array.isArray(rawFilenames)
            ? rawFilenames.flatMap((el) => {
                if (typeof el !== "string" || el === "") return [];
                const ct = isEncrypted(el) ? el : encryptField(dek, el);
                return ct ? [ct] : [];
              })
            : [];
          const withFks = {
            ...rest,
            userId,
            accountId: newAccountId,
            source: src,
            // Force encryption_tier='user' on restore — the operator is
            // restoring into an authenticated session with a DEK in scope,
            // and the original-tier may have been mid-upgrade in the
            // source DB. Re-encrypt under the local user DEK below.
            encryptionTier: "user",
            sourceFilenames: reEncFilenames,
            uploadBatchId: newBatchId,
          };
          return encryptRowFields(dek, withFks, BANK_TX_ENC_FIELDS);
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);
      if (remapped.length > 0) {
        const inserted = await db
          .insert(schema.bankTransactions)
          .values(remapped as (typeof schema.bankTransactions.$inferInsert)[])
          .returning({ id: schema.bankTransactions.id });
        // Walk parallel arrays — `remapped` skipped null-accountId rows so we
        // need an index that tracks the same skipping pattern on the source.
        let outIdx = 0;
        for (const old of d.bankTransactions) {
          if (old.accountId == null) continue;
          if (inserted[outIdx]) {
            bankTxIdMap.set(String(old.id), inserted[outIdx].id as string);
          }
          outIdx++;
        }
      }
    }

    // Insert transactions, remapping FK references. Plaintext text fields are
    // encrypted at the boundary; `v1:` ciphertext from a same-account backup
    // passes through unchanged.
    //
    // C-5 (2026-05-07): an unmapped accountId/categoryId throws rather than
    // passing the raw id through. Mirrors the canonical `strip()` helper above
    // — silently writing the source DB's integer id risked attaching the
    // restored row to another tenant's account/category whose serial PK
    // happened to match.
    const txnIdMap = new Map<number, number>();
    if (d.transactions?.length) {
      const remapped = d.transactions.map(({ id: _id, userId: _uid, accountId, categoryId, bankTransactionId: rawBankTxId, source: rawSource, ...rest }) => {
        // Issue #28: a backup that pre-dates the audit-fields migration has
        // no `source` per row — fall back to 'backup_restore'. Newer
        // backups round-trip the original surface (CSV-imported stays
        // 'import'). coerceSourceForRestore guards the CHECK constraint
        // from typo'd / corrupted JSON.
        let mappedAccountId: number | null;
        if (accountId == null) {
          mappedAccountId = null;
        } else {
          const newId = accountIdMap.get(accountId as number);
          if (newId == null) {
            throw new Error(
              `Backup transaction references unknown accountId=${String(accountId)} — accounts section missing or inconsistent`,
            );
          }
          mappedAccountId = newId;
        }
        let mappedCategoryId: number | null;
        if (categoryId == null) {
          mappedCategoryId = null;
        } else {
          const newId = categoryIdMap.get(categoryId as number);
          if (newId == null) {
            throw new Error(
              `Backup transaction references unknown categoryId=${String(categoryId)} — categories section missing or inconsistent`,
            );
          }
          mappedCategoryId = newId;
        }
        // Two-ledger refactor — remap bank_transaction_id via bankTxIdMap
        // (UUID → UUID). Pre-refactor backups have no column; the property
        // is absent and `mappedBankTxId` stays NULL (acceptable lineage
        // loss for old backups, same shape as pre-audit-trio rows).
        let mappedBankTxId: string | null = null;
        if (typeof rawBankTxId === "string" && rawBankTxId) {
          mappedBankTxId = bankTxIdMap.get(rawBankTxId) ?? null;
          // No throw on miss — the bank_transactions section may be absent
          // in older backups, in which case lineage is lost but the
          // transaction still restores correctly.
        }
        const withFks = {
          ...rest,
          userId,
          accountId: mappedAccountId,
          categoryId: mappedCategoryId,
          source: coerceSourceForRestore(rawSource),
          bankTransactionId: mappedBankTxId,
        };
        return encryptRowFields(dek, withFks, TX_ENC_FIELDS);
      });
      const inserted = await db
        .insert(schema.transactions)
        .values(remapped as (typeof schema.transactions.$inferInsert)[])
        .returning({ id: schema.transactions.id });
      d.transactions.forEach((old, i) => {
        if (inserted[i]) txnIdMap.set(old.id as number, inserted[i].id);
      });

      // Dual-write retrofit (Phase 5, 2026-05-23) — every restored tx
      // whose `bank_transaction_id` FK was just set gets a matching
      // 'primary' row in `transaction_bank_links`. Covers pre-Phase-5
      // backups (no explicit join section) and stays idempotent with
      // the explicit `transactionBankLinks[]` section below for post-
      // Phase-5 backups (ON CONFLICT dedupes the primary rows).
      const primaryLinkRows = inserted
        .map((row, i) => ({
          row,
          bankId: (remapped[i] as { bankTransactionId?: string | null })
            .bankTransactionId,
        }))
        .filter((r): r is { row: { id: number }; bankId: string } =>
          typeof r.bankId === "string" && r.bankId.length > 0,
        )
        .map(({ row, bankId }) => ({
          userId,
          transactionId: row.id,
          bankTransactionId: bankId,
          linkType: "primary" as const,
          source: "backup_restore" as const,
        }));
      if (primaryLinkRows.length > 0) {
        await db
          .insert(schema.transactionBankLinks)
          .values(primaryLinkRows)
          .onConflictDoNothing({
            target: [
              schema.transactionBankLinks.transactionId,
              schema.transactionBankLinks.bankTransactionId,
            ],
          });
      }
    }

    // Insert explicit transaction_bank_links from the backup (Phase 5,
    // 2026-05-23). Pre-Phase-5 backups don't have this section — the
    // FK-derived primary rows above cover the primary links and there
    // are no extras to restore. Post-Phase-5 backups serialize the full
    // join table so M:N extras round-trip.
    interface BackupLinkRow {
      transactionId: number;
      bankTransactionId: string;
      linkType?: string;
      source?: string;
    }
    const backupLinks = (d as { transactionBankLinks?: BackupLinkRow[] })
      .transactionBankLinks;
    if (backupLinks?.length) {
      const remappedLinks = backupLinks
        .map((l) => {
          const newTxId = txnIdMap.get(l.transactionId);
          const newBankId = bankTxIdMap.get(l.bankTransactionId);
          if (newTxId == null || newBankId == null) return null;
          return {
            userId,
            transactionId: newTxId,
            bankTransactionId: newBankId,
            linkType: l.linkType === "primary" ? "primary" : "extra",
            source: "backup_restore" as const,
          };
        })
        .filter(
          (r): r is {
            userId: string;
            transactionId: number;
            bankTransactionId: string;
            linkType: "primary" | "extra";
            source: "backup_restore";
          } => r != null,
        );
      if (remappedLinks.length > 0) {
        await db
          .insert(schema.transactionBankLinks)
          .values(remappedLinks)
          .onConflictDoNothing({
            target: [
              schema.transactionBankLinks.transactionId,
              schema.transactionBankLinks.bankTransactionId,
            ],
          });
      }
    }

    // ─── Bank balance anchors (2026-05-24) ─────────────────────────────
    //
    // Pure additive — anchors carry only an account FK, so remap it via
    // accountIdMap and re-INSERT. Anchors without a remappable account
    // are dropped (their account isn't in this backup; orphan FK would
    // throw on the actual INSERT). ON CONFLICT (user, account, date) DO
    // NOTHING — running an import twice is harmless.
    interface BackupAnchorRow {
      accountId: number;
      date: string;
      balance: number;
      currency?: string;
      source?: string;
      sourceFilenames?: string[];
      uploadBatchId?: string | null;
    }
    const backupAnchors = (d as { bankDailyBalances?: BackupAnchorRow[] })
      .bankDailyBalances;
    if (backupAnchors?.length) {
      const remappedAnchors = backupAnchors
        .map((a) => {
          const newAccountId = accountIdMap.get(a.accountId);
          if (newAccountId == null) return null;
          // Phase 4 (2026-05-25) — remap upload_batch_id through the
          // batch-id map. Pre-Phase-4 backups don't carry the column.
          const newBatchId =
            typeof a.uploadBatchId === "string" && bankUploadBatchIdMap.has(a.uploadBatchId)
              ? bankUploadBatchIdMap.get(a.uploadBatchId)!
              : null;
          return {
            userId,
            accountId: newAccountId,
            date: a.date,
            balance: Number(a.balance),
            currency: a.currency ?? "CAD",
            // Pre-2026-05-24 backups have no source value; fall back
            // to 'backup_restore' (CHECK constraint accepts it).
            source: typeof a.source === "string" && a.source.length > 0
              ? a.source
              : "backup_restore",
            sourceFilenames: Array.isArray(a.sourceFilenames)
              ? a.sourceFilenames
              : [],
            uploadBatchId: newBatchId,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r != null);
      if (remappedAnchors.length > 0) {
        await db
          .insert(schema.bankDailyBalances)
          .values(remappedAnchors)
          .onConflictDoNothing({
            target: [
              schema.bankDailyBalances.userId,
              schema.bankDailyBalances.accountId,
              schema.bankDailyBalances.date,
            ],
          });
      }
    }

    // Insert transaction splits with remapped IDs (also encrypting text fields)
    //
    // C-5 (2026-05-07): unmapped FKs throw instead of silently inserting the
    // raw id from the source DB. A split without a mapped parent transaction
    // is silently dropped (the parent transaction wasn't in the backup) —
    // that's the only soft path; account/category misses are hard fails.
    if (d.transactionSplits?.length && txnIdMap.size > 0) {
      const remapped = d.transactionSplits
        .map(({ id: _id, transactionId, accountId, categoryId, ...rest }) => {
          const newTxnId = txnIdMap.get(transactionId as number);
          if (newTxnId == null) {
            // Parent transaction not in this backup — skip the orphan split.
            return null;
          }
          let mappedAccountId: number | null;
          if (accountId == null) {
            mappedAccountId = null;
          } else {
            const newId = accountIdMap.get(accountId as number);
            if (newId == null) {
              throw new Error(
                `Backup split references unknown accountId=${String(accountId)} — accounts section missing or inconsistent`,
              );
            }
            mappedAccountId = newId;
          }
          let mappedCategoryId: number | null;
          if (categoryId == null) {
            mappedCategoryId = null;
          } else {
            const newId = categoryIdMap.get(categoryId as number);
            if (newId == null) {
              throw new Error(
                `Backup split references unknown categoryId=${String(categoryId)} — categories section missing or inconsistent`,
              );
            }
            mappedCategoryId = newId;
          }
          const withFks = {
            ...rest,
            transactionId: newTxnId,
            accountId: mappedAccountId,
            categoryId: mappedCategoryId,
          };
          return encryptRowFields(dek, withFks, SPLIT_ENC_FIELDS);
        })
        .filter((s): s is Row => s !== null);
      if (remapped.length) {
        await db
          .insert(schema.transactionSplits)
          .values(remapped as (typeof schema.transactionSplits.$inferInsert)[])
          ;
      }
    }

    // FK-bearing tables MUST receive the IdMaps so cross-tenant references
    // can't sneak through (see strip()'s docblock for the failure mode).
    // Tables without accountId/categoryId pass an empty remap.
    if (d.budgets?.length) {
      await db.insert(schema.budgets).values(strip(d.budgets, userId, { categoryIdMap }) as (typeof schema.budgets.$inferInsert)[]);
    }
    if (d.budgetTemplates?.length) {
      await db.insert(schema.budgetTemplates).values(strip(d.budgetTemplates, userId, { categoryIdMap }) as (typeof schema.budgetTemplates.$inferInsert)[]);
    }
    if (d.loans?.length) {
      await db.insert(schema.loans).values(strip(d.loans, userId, { accountIdMap }) as (typeof schema.loans.$inferInsert)[]);
    }
    // Insert goals, capture old→new id map for `goal_accounts` restore.
    const goalIdMap = new Map<number, number>();
    if (d.goals?.length) {
      const inserted = await db
        .insert(schema.goals)
        .values(strip(d.goals, userId, { accountIdMap }) as (typeof schema.goals.$inferInsert)[])
        .returning({ id: schema.goals.id });
      d.goals.forEach((old, i) => {
        if (inserted[i]) goalIdMap.set(old.id as number, inserted[i].id);
      });
    }
    // Issue #130 — multi-account goal links. Insert AFTER goals so goalIdMap
    // is populated. accountIdMap remap handles cross-tenant FK safety.
    if (d.goalAccounts?.length) {
      await db
        .insert(schema.goalAccounts)
        .values(strip(d.goalAccounts, userId, { accountIdMap, goalIdMap }) as (typeof schema.goalAccounts.$inferInsert)[]);
    }
    if (d.snapshots?.length) {
      await db.insert(schema.snapshots).values(strip(d.snapshots, userId, { accountIdMap }) as (typeof schema.snapshots.$inferInsert)[]);
    }
    if (d.targetAllocations?.length) {
      await db.insert(schema.targetAllocations).values(strip(d.targetAllocations, userId) as (typeof schema.targetAllocations.$inferInsert)[]);
    }
    if (d.recurringTransactions?.length) {
      await db.insert(schema.recurringTransactions).values(strip(d.recurringTransactions, userId, { accountIdMap, categoryIdMap }) as (typeof schema.recurringTransactions.$inferInsert)[]);
    }
    if (d.subscriptions?.length) {
      await db.insert(schema.subscriptions).values(strip(d.subscriptions, userId, { accountIdMap, categoryIdMap }) as (typeof schema.subscriptions.$inferInsert)[]);
    }
    if (d.transactionRules?.length) {
      // FINLYNQ-12 — pre-migration backups carry `isActive` as 0/1 (INTEGER);
      // post-migration the column is BOOLEAN. Coerce numeric values on import
      // so old backups keep restoring cleanly. `Boolean(0) === false`,
      // `Boolean(1) === true`; already-boolean values pass through unchanged.
      const stripped = strip(d.transactionRules, userId, { categoryIdMap }).map((row) => {
        if (Object.prototype.hasOwnProperty.call(row, "isActive")) {
          (row as { isActive: unknown }).isActive = Boolean((row as { isActive: unknown }).isActive);
        }
        return row;
      });
      await db.insert(schema.transactionRules).values(stripped as (typeof schema.transactionRules.$inferInsert)[]);
    }
    if (d.importTemplates?.length) {
      await db.insert(schema.importTemplates).values(strip(d.importTemplates, userId) as (typeof schema.importTemplates.$inferInsert)[]);
    }
    // Restore per-user FX overrides. Both `fxOverrides` (current shape) and
    // legacy `fxRates` (pre-2026-04-27 backups carrying user-pinned rate pairs)
    // are accepted. Legacy rows are converted to USD-anchored fx_overrides.
    if (d.fxOverrides?.length) {
      await db.insert(schema.fxOverrides).values(strip(d.fxOverrides, userId) as (typeof schema.fxOverrides.$inferInsert)[]);
    } else if (d.fxRates?.length) {
      const overrides: Array<{
        userId: string;
        currency: string;
        dateFrom: string;
        dateTo: string;
        rateToUsd: number;
        note: string;
      }> = [];
      for (const row of d.fxRates) {
        const r = row as { from_currency?: string; fromCurrency?: string; to_currency?: string; toCurrency?: string; date?: string; rate?: number };
        const from = (r.fromCurrency ?? r.from_currency ?? "").toUpperCase();
        const to = (r.toCurrency ?? r.to_currency ?? "").toUpperCase();
        const rate = typeof r.rate === "number" ? r.rate : 0;
        if (!from || !to || rate <= 0 || !r.date) continue;
        if (to === "USD") {
          overrides.push({ userId, currency: from, dateFrom: r.date, dateTo: r.date, rateToUsd: rate, note: "imported from legacy backup" });
        } else if (from === "USD") {
          overrides.push({ userId, currency: to, dateFrom: r.date, dateTo: r.date, rateToUsd: 1 / rate, note: "imported from legacy backup" });
        }
        // Cross-pair legacy rows (no USD side) are dropped — restore them
        // manually from the new override UI if needed.
      }
      if (overrides.length) {
        await db.insert(schema.fxOverrides).values(overrides);
      }
    }
    if (d.contributionRoom?.length) {
      await db.insert(schema.contributionRoom).values(strip(d.contributionRoom, userId) as (typeof schema.contributionRoom.$inferInsert)[]);
    }

    // Settings: upsert by key
    if (d.settings?.length) {
      for (const row of d.settings) {
        const { id: _id, userId: _uid, key, value } = row;
        await db
          .insert(schema.settings)
          .values({ key: key as string, value: value as string, userId })
          .onConflictDoUpdate({
            target: schema.settings.key,
            set: { value: value as string, userId },
          })
          ;
      }
    }

    invalidateUserTxCache(userId);
    return NextResponse.json({ success: true, preview });
  } catch (error: unknown) {
    const message = safeErrorMessage(error, "Restore failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
