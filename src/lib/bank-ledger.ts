/**
 * Bank-ledger upsert helper — single chokepoint for writes to the
 * `bank_transactions` persistent ledger (2026-05-22, two-ledger refactor).
 *
 * Every import-sourced INSERT into `transactions` must call this BEFORE
 * inserting the transaction, then stamp the returned id onto
 * `transactions.bank_transaction_id`. Manual entries (REST POST
 * /transactions, MCP HTTP record_transaction / bulk_record_transactions /
 * record_transfer / portfolio_* op tools) bypass this helper and leave the FK NULL.
 *
 * Tier selection: if `dek` is non-null, the row writes at user-tier (v1:
 * envelope under the user's DEK). If `dek` is null, the row writes at
 * service-tier (sv1: envelope under PF_STAGING_KEY) — only used by the
 * email-webhook ingest path. The login-time `upgradeStagingEncryption`
 * job re-encrypts service-tier rows under the user's DEK once it becomes
 * available.
 *
 * Idempotency: a re-import bumps `last_seen_at`, increments `seen_count`, and
 * appends to `source_filenames`. Content columns (`import_hash`, `fit_id`,
 * `date`, `amount`, `payee`, etc.) are NEVER updated — `bank_transactions` is
 * content-immutable once written.
 *
 * A row is recognised as a re-import by EITHER of the table's two unique
 * constraints: `uq_bank_tx_fit` (user_id, account_id, fit_id) when the source
 * supplied a bank FITID, else `uq_bank_tx_hash` (user_id, account_id,
 * import_hash, occurrence_index) via ON CONFLICT. The fit_id check runs first
 * and cannot be folded into the ON CONFLICT clause — one clause arbitrates one
 * index, and a bank that edits a transaction's content under a stable FITID
 * (pending→posted) changes the hash while keeping the fit_id. See the block
 * comment on that check for the failure it prevents.
 *
 * Returns `{ id, wasInserted }` so callers can distinguish a fresh ledger
 * entry from a re-import hit (used by the staging-upload preview to flag
 * `reconcile_state='skipped_duplicate'` on the staged row).
 *
 * See CLAUDE.md "Two-ledger import model" + docs/architecture/bank-ledger.md.
 */

import { sql } from "drizzle-orm";
import { db } from "@/db";
import { isPgErrorCode, normalizeDbRows, pgErrorConstraint } from "@/lib/db-utils";
import { encryptField } from "@/lib/crypto/envelope";
import { encryptStaged } from "@/lib/crypto/staging-envelope";
import { encryptStagingMeta } from "@/lib/crypto/staging-metadata";
import { SOURCES, type TransactionSource } from "@/lib/tx-source";

/**
 * Source attribution for a bank-ledger row. Strict subset of the SOURCES
 * tuple in src/lib/tx-source.ts — manual entries ('manual', 'mcp_http',
 * 'mcp_stdio', 'sample_data') never carry bank-statement lineage and go
 * straight to `transactions` with NULL `bank_transaction_id`. The bank
 * ledger receives writes only from 'import' (CSV/PDF/OFX/email approve),
 * 'connector' (automated pulls), and 'backup_restore' (which preserves
 * the original lineage). Keep this in lockstep with the SQL CHECK
 * constraint in scripts/migrations/20260522_bank-transactions-ledger.sql.
 */
export const BANK_LEDGER_SOURCES = [
  "import",
  "connector",
  "backup_restore",
] as const satisfies readonly TransactionSource[];

export type BankLedgerSource = (typeof BANK_LEDGER_SOURCES)[number];

const BANK_LEDGER_SOURCE_SET = new Set<string>(BANK_LEDGER_SOURCES);

export function isBankLedgerSource(v: unknown): v is BankLedgerSource {
  return typeof v === "string" && BANK_LEDGER_SOURCE_SET.has(v);
}

// Silence the unused-import lint when SOURCES is only referenced for its type.
void SOURCES;

/**
 * Input shape for {@link upsertBankTransaction}. Payee/note/tags/accountName
 * are PLAINTEXT — the helper handles encryption based on tier. `filename`
 * is a single string (the helper wraps it into a single-element array for
 * the upsert).
 */
export interface BankLedgerRowInput {
  userId: string;
  accountId: number;
  /** SHA256 hash from {@link generateImportHash}. */
  importHash: string;
  /**
   * 0-based offset within a (user, account, import_hash) group. Caller
   * computes via ROW_NUMBER() on the parsed batch — distinct rows whose
   * (date, amount, payee) collide get distinct indexes so they each land
   * as separate bank-ledger entries.
   */
  occurrenceIndex: number;
  fitId?: string | null;
  /** YYYY-MM-DD. */
  date: string;
  amount: number;
  currency: string;
  enteredAmount?: number | null;
  enteredCurrency?: string | null;
  enteredFxRate?: number | null;
  quantity?: number | null;
  payee: string;
  note?: string | null;
  tags?: string | null;
  /** Free-text account label from the source file's header. */
  accountName?: string | null;
  /**
   * FINLYNQ-195 — investment-import capture (v1). Security TICKER/SYMBOL +
   * security NAME mapped from a brokerage CSV when the target is an investment
   * account. PLAINTEXT in — the helper encrypts at the row's tier (v1: user-DEK
   * via encryptField, sv1: PF_STAGING_KEY via encryptStaged) exactly like
   * payee/note/tags/accountName. NULL for cash-account rows. Captured only —
   * v1 does NOT materialize lot-aware portfolio ops (deferred follow-up).
   */
  ticker?: string | null;
  securityName?: string | null;
  source: BankLedgerSource;
  /** Source filename. Wrapped into a single-element array. */
  filename?: string | null;
  /** Optional lineage hint — the staged_imports row that introduced this. */
  originalStagedImportId?: string | null;
  /** Phase 1 of import-modes refactor (2026-05-25) — the bank_upload_batches
   *  row this write belongs to. Populated by both the simplified-upload
   *  helper (direct path) and the post-Phase-3 approve route (detailed path).
   *  NULL for legacy paths that don't yet stamp a batch id. ON CONFLICT
   *  does NOT update this column — re-imports keep the original batch. */
  uploadBatchId?: string | null;
}

export interface BankLedgerUpsertResult {
  id: string;
  wasInserted: boolean;
}

/**
 * Insert-or-bump a bank_transactions row.
 *
 * @param dek - User's DEK for user-tier writes; null for service-tier
 *              (email-webhook ingest path).
 */
export async function upsertBankTransaction(
  dek: Buffer | null,
  row: BankLedgerRowInput,
): Promise<BankLedgerUpsertResult> {
  const tier = dek ? "user" : "service";

  // Encrypt the four ciphertext columns. Empty strings stay empty (matches
  // encryptField behavior). NULL stays NULL.
  const payee = dek ? encryptField(dek, row.payee) ?? "" : encryptStaged(row.payee) ?? "";
  const note =
    row.note == null ? null : dek ? encryptField(dek, row.note) : encryptStaged(row.note);
  const tags =
    row.tags == null ? null : dek ? encryptField(dek, row.tags) : encryptStaged(row.tags);
  const accountName =
    row.accountName == null
      ? null
      : dek
        ? encryptField(dek, row.accountName)
        : encryptStaged(row.accountName);
  // FINLYNQ-195 — TICKER + security NAME encrypted at the row's tier, same as
  // payee/note/tags/accountName. NULL stays NULL (cash-account rows).
  const ticker =
    row.ticker == null
      ? null
      : dek
        ? encryptField(dek, row.ticker)
        : encryptStaged(row.ticker);
  const securityName =
    row.securityName == null
      ? null
      : dek
        ? encryptField(dek, row.securityName)
        : encryptStaged(row.securityName);

  // source_filenames is TEXT[]. Drizzle's `${jsArray}::TEXT[]` pattern
  // doesn't serialize a JS array to PG's `{elem1,elem2}` literal form —
  // PG sees a bare string and 22P02s ("malformed array literal"). Build
  // the array inline with ARRAY[…] using a properly-bound element instead.
  //
  // FINLYNQ-132 — the filename element is ENCRYPTED at rest under the row's
  // tier (v1: user-DEK via encryptField, sv1: PF_STAGING_KEY via encryptStaged)
  // exactly like payee/note/tags/accountName above. Filenames leak bank name /
  // account fragments / statement period to a DB-dump attacker, so they never
  // land plaintext. Decryption branches per-row on encryption_tier at every
  // reader (export, login-sweep upgrade) via decryptStagingMeta. The audit
  // invariant `source-filenames-encrypted` guards this write-site — a raw
  // `ARRAY[${row.filename}]::TEXT[]` here (without the encrypt helper) fails
  // `npm run audit:invariants`. Keep the encrypt call in this file.
  const encFilename = row.filename
    ? encryptStagingMeta(row.filename, tier, dek)
    : null;
  const filenamesFragment = encFilename
    ? sql`ARRAY[${encFilename}]::TEXT[]`
    : sql`ARRAY[]::TEXT[]`;

  // `bank_transactions` carries TWO unique constraints, and a single ON
  // CONFLICT clause can only arbitrate ONE of them:
  //
  //   uq_bank_tx_hash — (user_id, account_id, import_hash, occurrence_index)
  //   uq_bank_tx_fit  — (user_id, account_id, fit_id) WHERE fit_id IS NOT NULL
  //
  // The INSERT below arbitrates the hash. But `import_hash` is computed over
  // date + amount + payee (generateImportHash), so when a bank re-sends a
  // transaction under the SAME FITID with edited content — the pending→posted
  // transition rewrites the description, moves the date to the post date, and
  // can settle at a different amount — the hash changes, the hash arbiter
  // misses, and the INSERT dies on uq_bank_tx_fit with a raw 23505 that aborts
  // the entire import batch. That fired twice on prod (2026-07-22, 2026-07-23).
  //
  // So when the row carries a fit_id, settle THAT constraint first. A hit is
  // the same bank transaction we already hold, so it takes the identical
  // re-import bump the ON CONFLICT path applies. Content is deliberately left
  // as first written: `bank_transactions` is content-immutable once written,
  // and reconcile links plus `transactions.bank_transaction_id` lineage already
  // point at the original values.
  const hasFitId = row.fitId != null && row.fitId !== "";

  const bumpByFitId = async (): Promise<BankLedgerUpsertResult | null> => {
    const bumped = await db.execute(sql`
      UPDATE bank_transactions SET
        last_seen_at = NOW(),
        seen_count = seen_count + 1,
        source_filenames = CASE
          WHEN ${encFilename}::TEXT IS NULL THEN source_filenames
          ELSE array_append(source_filenames, ${encFilename}::TEXT)
        END
      WHERE user_id = ${row.userId}
        AND account_id = ${row.accountId}
        AND fit_id = ${row.fitId}
      RETURNING id
    `);
    const hit = normalizeDbRows<{ id: string }>(bumped)[0];
    return hit ? { id: hit.id, wasInserted: false } : null;
  };

  if (hasFitId) {
    const hit = await bumpByFitId();
    if (hit) return hit;
  }

  // The `xmax = 0` trick distinguishes a fresh INSERT from an ON CONFLICT
  // UPDATE — xmax is 0 for newly-inserted tuples and non-0 for the
  // previously-committed tuple being touched.
  const runInsert = () => db.execute(sql`
    INSERT INTO bank_transactions (
      user_id, account_id, import_hash, occurrence_index, fit_id, date,
      amount, currency, entered_amount, entered_currency, entered_fx_rate,
      quantity, payee, note, tags, account_name, ticker, security_name,
      encryption_tier, source,
      source_filenames, original_staged_import_id, upload_batch_id
    )
    VALUES (
      ${row.userId},
      ${row.accountId},
      ${row.importHash},
      ${row.occurrenceIndex},
      ${row.fitId ?? null},
      ${row.date},
      ${row.amount},
      ${row.currency},
      ${row.enteredAmount ?? null},
      ${row.enteredCurrency ?? null},
      ${row.enteredFxRate ?? null},
      ${row.quantity ?? null},
      ${payee},
      ${note},
      ${tags},
      ${accountName},
      ${ticker},
      ${securityName},
      ${tier},
      ${row.source},
      ${filenamesFragment},
      ${row.originalStagedImportId ?? null},
      ${row.uploadBatchId ?? null}
    )
    ON CONFLICT (user_id, account_id, import_hash, occurrence_index)
    DO UPDATE SET
      last_seen_at = NOW(),
      seen_count = bank_transactions.seen_count + 1,
      source_filenames = CASE
        WHEN array_length(EXCLUDED.source_filenames, 1) IS NULL
          THEN bank_transactions.source_filenames
        ELSE array_append(bank_transactions.source_filenames, EXCLUDED.source_filenames[1])
      END
    RETURNING id, (xmax = 0) AS was_inserted
  `);

  let result: unknown;
  try {
    result = await runInsert();
  } catch (error) {
    // A concurrent writer claimed this fit_id between the lookup above and
    // this INSERT. Settle it the same way, once.
    if (
      hasFitId &&
      isPgErrorCode(error, "23505") &&
      pgErrorConstraint(error) === "uq_bank_tx_fit"
    ) {
      const hit = await bumpByFitId();
      if (hit) return hit;
    }
    throw error;
  }

  // Normalize result shape — pg drivers return { rows: [...] }, some
  // adapters return the array directly (mirrors the pattern in
  // src/lib/dividends-category.ts). Coerce via unknown to bypass the
  // generic-row typing on the QueryResult shape.
  const asUnknown = result as unknown;
  let rows: Array<{ id: string; was_inserted: boolean }> = [];
  if (asUnknown && typeof asUnknown === "object") {
    const maybeRows = (asUnknown as { rows?: unknown }).rows;
    if (Array.isArray(maybeRows)) {
      rows = maybeRows as Array<{ id: string; was_inserted: boolean }>;
    } else if (Array.isArray(asUnknown)) {
      rows = asUnknown as Array<{ id: string; was_inserted: boolean }>;
    }
  }
  if (rows.length === 0) {
    throw new Error("upsertBankTransaction: no row returned from RETURNING clause");
  }
  return { id: rows[0].id, wasInserted: rows[0].was_inserted };
}
