/**
 * Stage the sample OFX file as a pending import on the demo account.
 *
 * Called from scripts/seed-demo.ts after the demo user + accounts + transactions
 * are seeded. The file lives at pf-app/public/sample-statement.ofx so it's also
 * downloadable at https://<host>/sample-statement.ofx for users who want to try
 * the upload flow themselves.
 *
 * Idempotent: the seed wipes staged_imports for the demo user before reseeding
 * (added there alongside the call to this helper).
 */

import { randomUUID, createHash } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import type pg from "pg";
import { parseOfx } from "../src/lib/ofx-parser";
import { encryptField } from "../src/lib/crypto/envelope";

const STAGE_TTL_MS = 60 * 24 * 60 * 60 * 1000;

/** Mirror of src/lib/import-hash.ts generateImportHash() — kept local so the
 *  seed doesn't reach across into the Next.js bundle graph. Any drift here
 *  must match the canonical helper or the dedup probe in the staging upload
 *  route stops flagging the overlapping rows. */
function generateImportHash(
  date: string,
  accountId: number,
  amount: number,
  payee: string,
): string {
  const normalized = [
    date.trim(),
    String(accountId),
    amount.toFixed(2),
    (payee || "").trim().toLowerCase(),
  ].join("|");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

export interface StageSampleOfxInput {
  client: pg.PoolClient;
  userId: string;
  /** Demo user's DEK — `transactions` already use it, staging mirrors the
   *  user-tier path so the on-login upgrade job stays a no-op. */
  dek: Buffer;
  /** Destination Finlynq account id (Chequing). */
  accountId: number;
  /** Defaults to <repo>/pf-app/public/sample-statement.ofx. Overridable for
   *  tests. */
  ofxPath?: string;
}

export interface StageSampleOfxResult {
  stagedImportId: string;
  rowCount: number;
  skippedDuplicateCount: number;
}

export async function stageSampleOfxImport(
  input: StageSampleOfxInput,
): Promise<StageSampleOfxResult> {
  const { client, userId, dek, accountId } = input;
  const ofxPath =
    input.ofxPath ?? path.join(__dirname, "..", "public", "sample-statement.ofx");
  const raw = readFileSync(ofxPath, "utf8");
  const parsed = parseOfx(raw);

  if (parsed.transactions.length === 0) {
    throw new Error(
      `[seed-demo-pending-import] No transactions parsed from ${ofxPath}`,
    );
  }

  // Compute import_hash per row + probe existing transactions for matches.
  // The probe is what surfaces the "matches existing transaction" badge in
  // the two-pane view, so the seeded April rows (which carry import_hash now,
  // see seed-demo.ts) get correctly flagged on the overlapping OFX rows.
  const hashes = parsed.transactions.map((t) =>
    generateImportHash(t.date, accountId, t.amount, t.payee),
  );

  const probe = await client.query<{ import_hash: string }>(
    `SELECT import_hash FROM transactions
     WHERE user_id = $1 AND import_hash = ANY($2::text[])`,
    [userId, hashes],
  );
  const matchedHashes = new Set(probe.rows.map((r) => r.import_hash));

  // staged_imports row
  const stagedImportId = randomUUID();
  const expiresAt = new Date(Date.now() + STAGE_TTL_MS);
  const dateRangeStart = parsed.dateRange?.start ?? null;
  const dateRangeEnd = parsed.dateRange?.end ?? null;

  await client.query(
    `INSERT INTO staged_imports (
       id, user_id, source, status, total_row_count, duplicate_count,
       expires_at, statement_balance, statement_balance_date, statement_currency,
       statement_period_start, statement_period_end, bound_account_id,
       file_format, original_filename, date_range_start, date_range_end
     ) VALUES (
       $1, $2, 'upload', 'pending', $3, $4,
       $5, $6, $7, $8,
       $9, $10, $11,
       'ofx', 'sample-statement.ofx', $12, $13
     )`,
    [
      stagedImportId,
      userId,
      parsed.transactions.length,
      matchedHashes.size, // duplicate_count
      expiresAt.toISOString(),
      parsed.balanceAmount,
      parsed.balanceDate,
      parsed.currency,
      dateRangeStart,
      dateRangeEnd,
      accountId,
      dateRangeStart,
      dateRangeEnd,
    ],
  );

  // staged_transactions rows. User-tier encryption (sv2 v1: envelope) because
  // the seed has the DEK in scope — matches what /api/import/staging/upload
  // does for authenticated uploads. Avoids a service→user upgrade pass on
  // first login.
  let rowIndex = 0;
  for (let i = 0; i < parsed.transactions.length; i++) {
    const t = parsed.transactions[i];
    const hash = hashes[i];
    const isDup = matchedHashes.has(hash);
    const reconcileState = isDup ? "skipped_duplicate" : "unmatched";
    const txType: "I" | "E" = t.amount > 0 ? "I" : "E";
    await client.query(
      `INSERT INTO staged_transactions (
         id, staged_import_id, user_id, date, amount, currency,
         payee, category, account_name, note,
         row_index, is_duplicate, import_hash, encryption_tier,
         tx_type, fit_id, dedup_status, row_status, reconcile_state
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, NULL, NULL, $8,
         $9, $10, $11, 'user',
         $12, $13, $14, 'pending', $15
       )`,
      [
        randomUUID(),
        stagedImportId,
        userId,
        t.date,
        t.amount,
        parsed.currency,
        encryptField(dek, t.payee),
        encryptField(dek, t.memo ?? ""),
        rowIndex++,
        isDup,
        hash,
        txType,
        t.fitId,
        isDup ? "existing" : "new",
        reconcileState,
      ],
    );
  }

  return {
    stagedImportId,
    rowCount: parsed.transactions.length,
    skippedDuplicateCount: matchedHashes.size,
  };
}
