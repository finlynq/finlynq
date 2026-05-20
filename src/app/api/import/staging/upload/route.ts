/**
 * POST /api/import/staging/upload (issue #153)
 *
 * Upload a statement file (CSV / OFX / QFX) and persist parsed rows into the
 * staging tables (`staged_imports` + `staged_transactions`) for user review at
 * `/import/pending`. Replaces the old preview→commit pair on
 * `/api/import/reconcile/{preview,commit}`.
 *
 * Multipart body (mirrors the old reconcile preview route):
 *   file              — the statement (csv | ofx | qfx)
 *   accountId         — optional Finlynq account id (required for OFX/QFX)
 *   templateId        — optional saved CSV column mapping
 *   tolerance         — optional probable-duplicate fuzz window (days, default 3)
 *   statementBalance  — optional, CSV-only — user-typed statement balance
 *   action            — F-53E (FINLYNQ-58) merge prompt control:
 *                       'merge'  — append to existing pending batch named in `mergeIntoStagedImportId`
 *                       'new'    — bypass overlap detection, create a new batch
 *                       absent   — first-pass: server detects overlap and returns
 *                                  `{ data: { mergeCandidate } }` instead of inserting.
 *   mergeIntoStagedImportId — required when action='merge'; UUID of the target
 *                       `staged_imports` row (must belong to caller + status='pending').
 *
 * Returns:
 *   First-pass (no action) when overlap detected:
 *     { success: true, data: { mergeCandidate: { stagedImportId, dateRangeStart,
 *       dateRangeEnd, rowCount } } }     // HTTP 200; no DB write
 *   First-pass (no overlap) OR action='new':
 *     { stagedImportId, redirectTo, format, counts, tolerance }   // 200; new batch
 *   action='merge':
 *     { stagedImportId, redirectTo, format, counts: { appended, alreadyInBatch,
 *       skippedDuplicate, errors }, merged: true }                // 200; appended
 *
 * Encryption tier: uploads happen inside an authenticated session, so the
 * DEK is available — staged rows land directly at `encryption_tier='user'`
 * (v1: envelope under the user's DEK). Email-import staging stays at
 * `encryption_tier='service'` (PF_STAGING_KEY) because the webhook has no
 * DEK; the login-time upgrade job converts those rows on the next login.
 *
 * `import_hash` is computed at ingest from plaintext payee — load-bearing
 * per CLAUDE.md (the hash is dedup-stable and must NEVER be recomputed).
 * Merge-append rows carry the SAME hash they'd carry in a fresh batch.
 *
 * F-53E (FINLYNQ-58) — Already-imported marker: every newly-staged row is
 * probed against `transactions.import_hash` for the same user+accountId;
 * hits land at `reconcile_state='skipped_duplicate'` (default-excluded
 * from approve). Per CLAUDE.md "Do NOT silently flip skipped_duplicate
 * back to unmatched": the marker is only set at INSERT time; subsequent
 * row PATCHes preserve whatever value the user toggled to.
 *
 * `transactions.source` is stamped at approve time in the existing
 * `/api/import/staged/[id]/approve` endpoint. This route writes the
 * `staged_imports.source = 'upload'` and `staged_imports.file_format`
 * fields so the approve endpoint can choose the correct `source:<format>`
 * tag for `transactions.tags`.
 */

import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, eq, gte, inArray, lte, or } from "drizzle-orm";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { decryptName } from "@/lib/crypto/encrypted-columns";
import { encryptField, tryDecryptField } from "@/lib/crypto/envelope";
import {
  generateImportHash,
  checkDuplicates,
  checkFitIdDuplicates,
} from "@/lib/import-hash";
import { normalizeDate } from "@/lib/csv-parser";
import { parseOfx } from "@/lib/ofx-parser";
import { parseCsvWithFallback, type ParseError } from "@/lib/external-import/parsers/csv-pipeline";
import { isSupportedCurrency } from "@/lib/fx/supported-currencies";
import type { DateFormatOverride } from "@/lib/csv-parser";
import { parseOfxToCanonical } from "@/lib/external-import/parsers/ofx";
import { parseQfxToCanonical } from "@/lib/external-import/parsers/qfx";
import { detectProbableDuplicates } from "@/lib/external-import/duplicate-detect";
import { buildDuplicateCandidatePool } from "@/lib/external-import/duplicate-detect-pool";
import type { RawTransaction } from "@/lib/import-pipeline";
import { safeErrorMessage } from "@/lib/validate";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 20 * 1024 * 1024; // 20 MB
/** Hard cap so a single staging session stays cheap to classify + render. */
const MAX_STAGING_ROWS = 10_000;
/** 60 days — matches stage-email-import.ts (bumped 2026-05-06 alongside the
 *  login-time service→user upgrade job). */
const STAGE_TTL_MS = 60 * 24 * 60 * 60 * 1000;
const DEFAULT_DATE_TOLERANCE_DAYS = 3;

type FileFormat = "csv" | "ofx" | "qfx";

interface ParseSuccess {
  rows: RawTransaction[];
  errors: ParseError[];
  format: FileFormat;
  /** OFX only — extracted from <LEDGERBAL>. */
  statementBalance?: number | null;
  statementBalanceDate?: string | null;
  statementCurrency?: string | null;
}

interface ParseFailure {
  status: number;
  body: Record<string, unknown>;
}

export async function POST(request: NextRequest) {
  // Uploads write `encryption_tier='user'` rows directly, so a DEK is required.
  // 423s if the session isn't unlocked — caller re-logs in and retries.
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;

  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: `Request body exceeds ${MAX_BODY_BYTES} byte limit` },
      { status: 413 },
    );
  }

  try {
    const formData = (await request.formData()) as unknown as globalThis.FormData;
    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const accountIdRaw = formData.get("accountId");
    const accountId =
      accountIdRaw && typeof accountIdRaw === "string" && accountIdRaw.trim()
        ? Number.parseInt(accountIdRaw, 10)
        : null;
    if (accountId !== null && (Number.isNaN(accountId) || accountId <= 0)) {
      return NextResponse.json({ error: "Invalid accountId" }, { status: 400 });
    }
    const templateIdRaw = formData.get("templateId");
    const templateId =
      templateIdRaw && typeof templateIdRaw === "string" && templateIdRaw.trim()
        ? Number.parseInt(templateIdRaw, 10)
        : null;
    const toleranceRaw = formData.get("tolerance");
    const tolerance =
      toleranceRaw && typeof toleranceRaw === "string" && toleranceRaw.trim()
        ? Number.parseInt(toleranceRaw, 10)
        : DEFAULT_DATE_TOLERANCE_DAYS;
    if (Number.isNaN(tolerance) || tolerance < 0 || tolerance > 30) {
      return NextResponse.json(
        { error: "tolerance must be between 0 and 30 days" },
        { status: 400 },
      );
    }

    // ─── F-53E merge prompt control (FINLYNQ-58) ─────────────────────────
    // action='merge' → append non-collision rows to an existing pending
    //                  staged_imports row named in mergeIntoStagedImportId.
    // action='new'   → bypass overlap detection (user picked "Create new
    //                  batch" in the merge modal).
    // absent         → first-pass; server runs overlap detection and may
    //                  return { mergeCandidate } instead of inserting.
    const actionRaw = formData.get("action");
    const action =
      actionRaw && typeof actionRaw === "string" && actionRaw.trim()
        ? actionRaw.trim().toLowerCase()
        : null;
    if (action !== null && action !== "merge" && action !== "new") {
      return NextResponse.json(
        { error: "action must be one of: 'merge', 'new' (or absent)" },
        { status: 400 },
      );
    }
    const mergeTargetIdRaw = formData.get("mergeIntoStagedImportId");
    const mergeTargetId =
      mergeTargetIdRaw && typeof mergeTargetIdRaw === "string" && mergeTargetIdRaw.trim()
        ? mergeTargetIdRaw.trim()
        : null;
    if (action === "merge" && !mergeTargetId) {
      return NextResponse.json(
        { error: "action='merge' requires mergeIntoStagedImportId" },
        { status: 400 },
      );
    }
    if (action !== "merge" && mergeTargetId) {
      return NextResponse.json(
        { error: "mergeIntoStagedImportId is only valid when action='merge'" },
        { status: 400 },
      );
    }
    // ─── FINLYNQ-54 parser knobs ─────────────────────────────────────
    // All five are optional; the form sends defaults when collapsed.
    const skipHeaderRowsRaw = formData.get("skipHeaderRows");
    const skipFooterRowsRaw = formData.get("skipFooterRows");
    const dateFormatOverrideRaw = formData.get("dateFormatOverride");
    const defaultCurrencyRaw = formData.get("defaultCurrency");

    let skipHeaderRows = 0;
    if (skipHeaderRowsRaw && typeof skipHeaderRowsRaw === "string" && skipHeaderRowsRaw.trim()) {
      const n = Number.parseInt(skipHeaderRowsRaw, 10);
      if (Number.isNaN(n) || n < 0 || n > 100) {
        return NextResponse.json(
          { error: "skipHeaderRows must be an integer between 0 and 100" },
          { status: 400 },
        );
      }
      skipHeaderRows = n;
    }

    let skipFooterRows = 0;
    if (skipFooterRowsRaw && typeof skipFooterRowsRaw === "string" && skipFooterRowsRaw.trim()) {
      const n = Number.parseInt(skipFooterRowsRaw, 10);
      if (Number.isNaN(n) || n < 0 || n > 100) {
        return NextResponse.json(
          { error: "skipFooterRows must be an integer between 0 and 100" },
          { status: 400 },
        );
      }
      skipFooterRows = n;
    }

    let dateFormatOverride: DateFormatOverride | null = null;
    if (dateFormatOverrideRaw && typeof dateFormatOverrideRaw === "string") {
      const v = dateFormatOverrideRaw.trim();
      if (v && v !== "auto") {
        if (v !== "DD/MM/YYYY" && v !== "MM/DD/YYYY" && v !== "YYYY-MM-DD") {
          return NextResponse.json(
            { error: "dateFormatOverride must be one of: auto, DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD" },
            { status: 400 },
          );
        }
        dateFormatOverride = v;
      }
    }

    let defaultCurrency: string | null = null;
    if (defaultCurrencyRaw && typeof defaultCurrencyRaw === "string" && defaultCurrencyRaw.trim()) {
      const code = defaultCurrencyRaw.trim().toUpperCase();
      if (!isSupportedCurrency(code)) {
        return NextResponse.json(
          { error: `Unsupported defaultCurrency: ${code}` },
          { status: 400 },
        );
      }
      defaultCurrency = code;
    }

    // Optional user-typed statement balance (CSV/XLSX where we can't parse it).
    const statementBalanceRaw = formData.get("statementBalance");
    let userStatementBalance: number | null = null;
    if (
      statementBalanceRaw &&
      typeof statementBalanceRaw === "string" &&
      statementBalanceRaw.trim()
    ) {
      const n = Number(statementBalanceRaw);
      if (Number.isNaN(n) || !Number.isFinite(n)) {
        return NextResponse.json(
          { error: "statementBalance must be a number" },
          { status: 400 },
        );
      }
      userStatementBalance = n;
    }

    // ─── F-53E merge target pre-validation (FINLYNQ-58) ──────────────────
    // When action='merge', verify the target staged_import belongs to this
    // user AND is still in status='pending' BEFORE parsing the file.
    // CLAUDE.md "Do NOT merge across users" + "Do NOT merge into a batch in
    // status != 'pending'". Cross-tenant attacks 404 here. We re-load the
    // row inside the transaction below, but failing fast saves a parse
    // round-trip when the target is obviously wrong.
    let mergeTarget: typeof schema.stagedImports.$inferSelect | null = null;
    if (action === "merge" && mergeTargetId) {
      const candidate = await db
        .select()
        .from(schema.stagedImports)
        .where(and(
          eq(schema.stagedImports.id, mergeTargetId),
          eq(schema.stagedImports.userId, userId),
        ))
        .get();
      if (!candidate) {
        // Same 404 shape as the rest of the staging surface — never leak
        // whether the id exists for another tenant.
        return NextResponse.json({ error: "Merge target not found" }, { status: 404 });
      }
      if (candidate.status !== "pending") {
        return NextResponse.json(
          { error: "Merge target is not pending — partially-approved batches are immutable" },
          { status: 409 },
        );
      }
      mergeTarget = candidate;
    }

    // Resolve the bound account name if accountId is supplied. OFX/QFX
    // single-account statements need it; CSVs use it as a fallback when
    // no `Account` column is present.
    let defaultAccountName: string | null = null;
    let boundAccountCurrency: string | null = null;
    if (accountId !== null) {
      const acct = await db
        .select({
          id: schema.accounts.id,
          nameCt: schema.accounts.nameCt,
          currency: schema.accounts.currency,
        })
        .from(schema.accounts)
        .where(
          and(
            eq(schema.accounts.userId, userId),
            eq(schema.accounts.id, accountId),
          ),
        )
        .get();
      if (!acct) {
        return NextResponse.json(
          { error: `Account #${accountId} not found` },
          { status: 404 },
        );
      }
      defaultAccountName = decryptName(acct.nameCt, dek, null) ?? "";
      boundAccountCurrency = acct.currency;
    }

    const ext = file.name.split(".").pop()?.toLowerCase();
    const parseResult = await parseStatement(
      file,
      ext,
      templateId,
      userId,
      defaultAccountName,
      { skipHeaderRows, skipFooterRows, dateFormatOverride },
    );
    if ("status" in parseResult) {
      return NextResponse.json(parseResult.body, { status: parseResult.status });
    }
    if (parseResult.rows.length === 0) {
      return NextResponse.json(
        { error: "No transactions found in file" },
        { status: 400 },
      );
    }
    if (parseResult.rows.length > MAX_STAGING_ROWS) {
      return NextResponse.json(
        {
          error: `Statement contains ${parseResult.rows.length.toLocaleString()} rows, exceeding the ${MAX_STAGING_ROWS.toLocaleString()} staging limit. Split the file.`,
        },
        { status: 422 },
      );
    }

    // ─── Classify rows ──────────────────────────────────────────────────
    // Replicates the three-way classifier from src/lib/reconcile.ts so the
    // review UI can render NEW / EXISTING / PROBABLE_DUPLICATE counts
    // without re-running on page load. Decision is persisted to
    // staged_transactions.dedup_status.
    const accountLookup = await buildAccountLookup(userId, dek);
    type Shaped = {
      rowIndex: number;
      date: string;
      account: string;
      accountId: number | null;
      amount: number;
      payee: string;
      category?: string;
      currency?: string;
      enteredAmount?: number;
      enteredCurrency?: string;
      note?: string;
      tags?: string;
      quantity?: number;
      portfolioHolding?: string;
      fitId?: string;
      hash: string;
      dedupStatus: "new" | "existing" | "probable_duplicate";
    };
    const shaped: Shaped[] = [];
    const rowErrors: Array<{ rowIndex: number; message: string }> = [];

    for (let i = 0; i < parseResult.rows.length; i++) {
      const row = parseResult.rows[i];
      if (!row.date) {
        rowErrors.push({ rowIndex: i, message: "Missing date" });
        continue;
      }
      const normalizedDate = normalizeDate(row.date);
      if (!normalizedDate) {
        rowErrors.push({
          rowIndex: i,
          message: `Invalid date "${row.date}". Expected YYYY-MM-DD, MM/DD/YYYY, or DD-MM-YYYY.`,
        });
        continue;
      }
      if (typeof row.amount !== "number" || Number.isNaN(row.amount)) {
        rowErrors.push({ rowIndex: i, message: "Invalid amount" });
        continue;
      }
      const accountKey = (row.account ?? "").toLowerCase().trim();
      const acct = accountKey ? accountLookup.get(accountKey) : undefined;
      const resolvedAccountId = acct?.id ?? null;
      // Hash uses 0 when accountId is unknown — matches reconcile.ts. Real
      // hash is recomputed (via generateImportHash) at approve time after the
      // user has bound the account in the review UI.
      const hash = generateImportHash(
        normalizedDate,
        resolvedAccountId ?? 0,
        row.amount,
        row.payee ?? "",
      );
      shaped.push({
        rowIndex: i,
        date: normalizedDate,
        account: row.account ?? "",
        accountId: resolvedAccountId,
        amount: row.amount,
        payee: row.payee ?? "",
        category: row.category,
        currency: row.currency,
        enteredAmount: row.enteredAmount,
        enteredCurrency: row.enteredCurrency,
        note: row.note,
        tags: row.tags,
        quantity: row.quantity,
        portfolioHolding: row.portfolioHolding,
        fitId: row.fitId,
        hash,
        dedupStatus: "new",
      });
    }

    // Exact-match dedup pass (fit_id + import_hash). Same as reconcile
    // classifier — rows that already exist in `transactions` flip to EXISTING.
    const fitIds = shaped.filter((r) => r.fitId).map((r) => r.fitId!);
    const hashes = shaped.filter((r) => r.accountId !== null).map((r) => r.hash);
    const existingFitIds = await checkFitIdDuplicates(fitIds, userId);
    const existingHashes = await checkDuplicates(hashes, userId);

    const exactMatchedTxIds = new Set<number>();
    const fitIdHits = fitIds.filter((f) => existingFitIds.has(f));
    const hashHits = hashes.filter((h) => existingHashes.has(h));
    if (fitIdHits.length > 0 || hashHits.length > 0) {
      // Pull the matched transaction ids so the probable-duplicate pass
      // doesn't also flag the same existing row. Mirrors reconcile.ts.
      // inArray(col, []) renders as `false` in drizzle so OR is safe to use
      // unconditionally — the empty arm just contributes nothing.
      const matchRows = await db
        .select({ id: schema.transactions.id })
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.userId, userId),
            or(
              inArray(schema.transactions.fitId, fitIdHits),
              inArray(schema.transactions.importHash, hashHits),
            ),
          ),
        )
        .all();
      for (const m of matchRows) exactMatchedTxIds.add(m.id);
    }
    for (const r of shaped) {
      const isFitHit = !!r.fitId && existingFitIds.has(r.fitId);
      const isHashHit = r.accountId !== null && existingHashes.has(r.hash);
      if (isFitHit || isHashHit) {
        r.dedupStatus = "existing";
      }
    }

    // Probable-duplicate pass: rows still NEW with a resolved account.
    const candidates = shaped.filter(
      (r) => r.dedupStatus === "new" && r.accountId !== null,
    );
    if (candidates.length > 0) {
      const accountIds = Array.from(new Set(candidates.map((r) => r.accountId!)));
      const dates = candidates.map((r) => r.date).sort();
      const dateMin = dates[0];
      const dateMax = dates[dates.length - 1];
      const pool = await buildDuplicateCandidatePool({
        userId,
        dek,
        accountIds,
        dateMin,
        dateMax,
        dateToleranceDays: tolerance,
      });
      if (exactMatchedTxIds.size > 0) {
        for (const arr of pool.byAccount.values()) {
          for (let i = arr.length - 1; i >= 0; i--) {
            if (exactMatchedTxIds.has(arr[i].id)) arr.splice(i, 1);
          }
        }
      }
      const matches = detectProbableDuplicates(
        candidates.map((c) => ({
          rowIndex: c.rowIndex,
          date: c.date,
          accountId: c.accountId!,
          amount: c.amount,
          payeePlain: c.payee,
          importHash: c.hash,
        })),
        pool,
        {
          dateToleranceDays: tolerance,
          amountTolerancePct: 0,
          amountToleranceFloor: 0.005,
          scoreThreshold: 0.5,
        },
      );
      const matchedRowIndices = new Set(matches.map((m) => m.rowIndex));
      for (const r of candidates) {
        if (matchedRowIndices.has(r.rowIndex)) {
          r.dedupStatus = "probable_duplicate";
        }
      }
    }

    // Period-bounds for staged_imports — derived from the parsed rows.
    const allDates = shaped.map((r) => r.date).sort();
    const statementPeriodStart = allDates[0] ?? null;
    const statementPeriodEnd = allDates[allDates.length - 1] ?? null;
    // FINLYNQ-58 — date_range_* mirrors the parsed-row span for overlap
    // detection. Today they're identical to statement_period_* (both
    // derived from min/max row date); the column split lets the OFX
    // path diverge in future (where statement_period_* would come from
    // <DTSTART>/<DTEND> while date_range_* stays row-derived).
    const dateRangeStart = statementPeriodStart;
    const dateRangeEnd = statementPeriodEnd;

    // ─── F-53E overlap detection (FINLYNQ-58) ────────────────────────────
    // First-pass (no `action` field): look for an existing pending
    // staged_imports row for the same user+account whose [date_range_start,
    // date_range_end] overlaps the new upload. If found, return a
    // mergeCandidate descriptor WITHOUT inserting; the client renders the
    // merge / create-new / cancel modal and re-fires with action set.
    //
    // Constraints from CLAUDE.md / item body:
    //   - same user (cross-tenant guard via WHERE user_id = userId)
    //   - same accountId (cross-account uploads don't overlap by definition)
    //   - status='pending' (immutable batches don't accept merges)
    //   - both date ranges must be populated (NULL rows are pre-FINLYNQ-58)
    //   - overlap predicate: range_start <= new_end AND range_end >= new_start
    //
    // Skips when accountId is null (CSV without a bound account — no useful
    // grain for overlap detection; the user reviews per-row in /import/pending).
    if (action === null && accountId !== null && dateRangeStart && dateRangeEnd) {
      const overlapping = await db
        .select({
          id: schema.stagedImports.id,
          dateRangeStart: schema.stagedImports.dateRangeStart,
          dateRangeEnd: schema.stagedImports.dateRangeEnd,
          rowCount: schema.stagedImports.totalRowCount,
          originalFilename: schema.stagedImports.originalFilename,
        })
        .from(schema.stagedImports)
        .where(and(
          eq(schema.stagedImports.userId, userId),
          eq(schema.stagedImports.boundAccountId, accountId),
          eq(schema.stagedImports.status, "pending"),
          // YYYY-MM-DD strings sort lexicographically as dates do. Drizzle
          // `lte`/`gte` on a text column does the right thing here.
          lte(schema.stagedImports.dateRangeStart, dateRangeEnd),
          gte(schema.stagedImports.dateRangeEnd, dateRangeStart),
        ))
        .all();
      if (overlapping.length > 0) {
        // Surface the most-recent candidate (lexically-largest id is a
        // reasonable proxy — UUID v4 doesn't sort by creation but the
        // first match is fine for the modal; the user picks).
        const candidate = overlapping[0];
        return NextResponse.json({
          success: true,
          data: {
            mergeCandidate: {
              stagedImportId: candidate.id,
              dateRangeStart: candidate.dateRangeStart,
              dateRangeEnd: candidate.dateRangeEnd,
              rowCount: candidate.rowCount,
              originalFilename: candidate.originalFilename,
            },
          },
        });
      }
    }

    // ─── F-53E already-imported probe (FINLYNQ-58) ───────────────────────
    // Per-row: does any `transactions.import_hash` already match this
    // user+account? If yes, the staged row lands at
    // `reconcile_state='skipped_duplicate'` so the approve handler excludes
    // it by default and the UI surfaces an "already imported" badge.
    //
    // Distinct from the existing dedup_status='existing' path (which is
    // also driven by import_hash collisions): the marker is a per-row
    // *user-overridable* state on the new column, while dedup_status is
    // the parser-level classification. Both can be true (a row that was
    // already imported is also classified existing); the marker is what
    // the UI badge + approve-default-exclude reads.
    //
    // Skips when accountId is null (hash collision needs the account to be
    // a stable key — the upload classifier uses `accountId ?? 0` in the
    // hash, so cross-account hash collisions are noise).
    const alreadyImportedHashes = new Set<string>();
    if (accountId !== null) {
      const hashesToProbe = shaped
        .filter((r) => r.accountId !== null)
        .map((r) => r.hash);
      if (hashesToProbe.length > 0) {
        // Uses the new idx_transactions_user_import_hash index. SELECT
        // import_hash because we only need the column we're matching on.
        const hits = await db
          .select({ importHash: schema.transactions.importHash })
          .from(schema.transactions)
          .where(and(
            eq(schema.transactions.userId, userId),
            inArray(schema.transactions.importHash, hashesToProbe),
          ))
          .all();
        for (const h of hits) {
          if (h.importHash) alreadyImportedHashes.add(h.importHash);
        }
      }
    }

    // Statement-balance source priority:
    //   OFX/QFX <LEDGERBAL>  > user-typed (CSV form field)
    const statementBalance =
      parseResult.statementBalance ?? userStatementBalance ?? null;
    const statementBalanceDate =
      parseResult.statementBalanceDate ?? statementPeriodEnd ?? null;
    const statementCurrency =
      parseResult.statementCurrency ?? boundAccountCurrency ?? null;

    // Tx-type per row: 'I' for income (amount > 0), 'E' for expense (≤0).
    // Transfers ('R') need both legs and explicit pairing — out of scope
    // for the upload path (separate ticket #155).
    const txTypeFor = (amount: number): "E" | "I" => (amount > 0 ? "I" : "E");

    // FINLYNQ-58 — pre-build the per-row staged_transactions VALUES shape.
    // Used for both the new-batch INSERT and the merge-append INSERT path,
    // so the encryption + reconcile_state seeding logic stays in one place.
    // `reconcile_state` is driven by the F-53E already-imported probe above;
    // 'skipped_duplicate' is set ONLY on first INSERT (the user can later
    // toggle back to 'unmatched' via the row PATCH — load-bearing per
    // CLAUDE.md "Do NOT silently flip skipped_duplicate back to unmatched").
    const buildStagedRow = (r: typeof shaped[number], stagedImportIdLocal: string) => ({
      id: randomUUID(),
      stagedImportId: stagedImportIdLocal,
      userId,
      date: r.date,
      amount: r.amount,
      // Currency priority: row-supplied > default-currency knob >
      // bound-account currency > hard fallback. The knob only fires
      // for rows that didn't carry a currency themselves (FINLYNQ-54).
      currency: r.currency ?? defaultCurrency ?? boundAccountCurrency ?? "CAD",
      // User-tier encryption: DEK is available, so wrap directly under
      // the user's DEK (v1: envelope) rather than the staging key.
      // Read paths (staged/[id] GET + approve) branch on
      // `encryption_tier` and pick tryDecryptField(dek, ...) for
      // 'user' rows. See CLAUDE.md "Staged-transactions reads MUST
      // branch on encryption_tier per row".
      payee: encryptField(dek, r.payee) ?? null,
      category: encryptField(dek, r.category ?? null),
      accountName: encryptField(dek, r.account || null),
      note: encryptField(dek, r.note ?? null),
      rowIndex: r.rowIndex,
      isDuplicate: r.dedupStatus !== "new",
      importHash: r.hash,
      encryptionTier: "user",
      txType: txTypeFor(r.amount),
      quantity: r.quantity ?? null,
      portfolioHoldingId: null,
      enteredAmount: r.enteredAmount ?? null,
      // Default-currency knob also backstops entered_currency (FINLYNQ-54)
      // so cross-currency rows that came in without one don't get
      // mis-interpreted as bound-account-currency at approve time.
      enteredCurrency: r.enteredCurrency ?? defaultCurrency ?? null,
      tags: r.tags ?? null,
      fitId: r.fitId ?? null,
      peerStagedId: null,
      targetAccountId: null,
      dedupStatus: r.dedupStatus,
      rowStatus: "pending",
      // FINLYNQ-58 — already-imported marker. The hash probe above checked
      // `transactions.import_hash` for this user; hits land at
      // 'skipped_duplicate' so approve excludes them by default and the
      // UI badge fires.
      reconcileState: alreadyImportedHashes.has(r.hash) ? "skipped_duplicate" : "unmatched",
    });

    // ─── F-53E merge-append path (FINLYNQ-58) ────────────────────────────
    // action='merge' — append non-collision rows to mergeTarget instead of
    // creating a new staged_imports row. Collisions are dropped silently
    // (surfaced as a count in the response). Load-bearing rules:
    //   - import_hash is NOT recomputed (build-row uses r.hash verbatim).
    //   - Existing staged_imports row is NOT deleted/replaced (append-only).
    //   - The target's `created_at`, parser knobs, statement_period_*, etc.
    //     stay untouched; we only bump totalRowCount + duplicateCount and
    //     widen date_range_* to encompass the new rows.
    if (action === "merge" && mergeTarget) {
      // Inside the same `dev` row, collisions can come from two sources:
      //  (a) collisions with rows already in the existing staged batch
      //      (import_hash match) — drop silently with a count.
      //  (b) collisions with rows in the live `transactions` table —
      //      already handled by the alreadyImportedHashes probe above;
      //      those rows ARE appended but flagged 'skipped_duplicate'.
      const existingInBatch = await db
        .select({ importHash: schema.stagedTransactions.importHash })
        .from(schema.stagedTransactions)
        .where(eq(schema.stagedTransactions.stagedImportId, mergeTarget.id))
        .all();
      const existingHashSet = new Set<string>(
        existingInBatch.map((r) => r.importHash).filter((h): h is string => !!h),
      );
      const appendable = shaped.filter((r) => !existingHashSet.has(r.hash));
      const alreadyInBatch = shaped.length - appendable.length;

      // Widen the target's date_range to encompass appendable rows. NULL
      // pre-existing range_* (legacy batches) takes the new range outright.
      const appendableDates = appendable.map((r) => r.date).sort();
      const newRangeStart = appendableDates[0] ?? null;
      const newRangeEnd = appendableDates[appendableDates.length - 1] ?? null;
      const widenedStart =
        mergeTarget.dateRangeStart && newRangeStart
          ? (mergeTarget.dateRangeStart < newRangeStart ? mergeTarget.dateRangeStart : newRangeStart)
          : (mergeTarget.dateRangeStart ?? newRangeStart);
      const widenedEnd =
        mergeTarget.dateRangeEnd && newRangeEnd
          ? (mergeTarget.dateRangeEnd > newRangeEnd ? mergeTarget.dateRangeEnd : newRangeEnd)
          : (mergeTarget.dateRangeEnd ?? newRangeEnd);

      let appendedSkippedDuplicate = 0;
      await db.transaction(async (tx) => {
        if (appendable.length > 0) {
          const chunk = 500;
          for (let i = 0; i < appendable.length; i += chunk) {
            const slice = appendable.slice(i, i + chunk);
            await tx.insert(schema.stagedTransactions).values(
              slice.map((r) => buildStagedRow(r, mergeTarget!.id)),
            );
          }
          appendedSkippedDuplicate = appendable.filter(
            (r) => alreadyImportedHashes.has(r.hash),
          ).length;
        }
        // Bump totalRowCount + duplicateCount on the target. Re-read inside
        // the transaction to avoid a lost-update race vs other writers.
        await tx
          .update(schema.stagedImports)
          .set({
            totalRowCount: mergeTarget!.totalRowCount + appendable.length,
            duplicateCount:
              mergeTarget!.duplicateCount +
              appendable.filter((r) => r.dedupStatus !== "new").length,
            dateRangeStart: widenedStart,
            dateRangeEnd: widenedEnd,
          })
          .where(and(
            eq(schema.stagedImports.id, mergeTarget!.id),
            eq(schema.stagedImports.userId, userId),
          ));
      });

      return NextResponse.json({
        stagedImportId: mergeTarget.id,
        redirectTo: `/import/pending?id=${encodeURIComponent(mergeTarget.id)}`,
        format: parseResult.format,
        merged: true,
        counts: {
          appended: appendable.length,
          alreadyInBatch,
          skippedDuplicate: appendedSkippedDuplicate,
          errors: rowErrors.length + parseResult.errors.length,
        },
        tolerance,
      });
    }

    // ─── Default path: create a new staged_imports row ───────────────────
    // Reached when action='new' (overlap modal said "Create new batch") OR
    // when no overlap was detected on the first pass.
    const stagedImportId = randomUUID();
    const expiresAt = new Date(Date.now() + STAGE_TTL_MS);
    const dupCount = shaped.filter((r) => r.dedupStatus !== "new").length;

    await db.transaction(async (tx) => {
      await tx.insert(schema.stagedImports).values({
        id: stagedImportId,
        userId,
        source: "upload",
        fromAddress: null,
        subject: null,
        svixId: null,
        status: "pending",
        totalRowCount: shaped.length,
        duplicateCount: dupCount,
        expiresAt,
        statementBalance,
        statementBalanceDate,
        statementCurrency,
        statementPeriodStart,
        statementPeriodEnd,
        boundAccountId: accountId,
        fileFormat: parseResult.format,
        originalFilename: file.name,
        // FINLYNQ-54 parser knobs — persisted so the F-53E merge flow can
        // read them back. Defaults match pre-FINLYNQ-54 behavior.
        skipHeaderRows,
        skipFooterRows,
        dateFormatOverride,
        defaultCurrency,
        // FINLYNQ-58 — date_range_* drives the merge-prompt overlap check
        // on future uploads to the same account. Mirrors statement_period_*
        // today; column split lets divergence happen later.
        dateRangeStart,
        dateRangeEnd,
      });

      if (shaped.length > 0) {
        const chunk = 500;
        for (let i = 0; i < shaped.length; i += chunk) {
          const slice = shaped.slice(i, i + chunk);
          await tx.insert(schema.stagedTransactions).values(
            slice.map((r) => buildStagedRow(r, stagedImportId)),
          );
        }
      }
    });

    return NextResponse.json({
      stagedImportId,
      redirectTo: `/import/pending?id=${encodeURIComponent(stagedImportId)}`,
      format: parseResult.format,
      counts: {
        new: shaped.filter((r) => r.dedupStatus === "new").length,
        existing: shaped.filter((r) => r.dedupStatus === "existing").length,
        probableDuplicate: shaped.filter((r) => r.dedupStatus === "probable_duplicate").length,
        skippedDuplicate: shaped.filter((r) => alreadyImportedHashes.has(r.hash)).length,
        errors: rowErrors.length + parseResult.errors.length,
      },
      tolerance,
    });
  } catch (error) {
    const message = safeErrorMessage(error, "Staging upload failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

async function parseStatement(
  file: File,
  ext: string | undefined,
  templateId: number | null,
  userId: string,
  defaultAccountName: string | null,
  knobs: {
    skipHeaderRows: number;
    skipFooterRows: number;
    dateFormatOverride: DateFormatOverride | null;
  },
): Promise<ParseSuccess | ParseFailure> {
  if (ext === "csv") {
    const text = await file.text();
    const result = await parseCsvWithFallback({
      text,
      userId,
      templateId,
      defaultAccountName,
      skipHeaderRows: knobs.skipHeaderRows,
      skipFooterRows: knobs.skipFooterRows,
      dateFormatOverride: knobs.dateFormatOverride,
    });
    if (result.kind === "template-not-found") {
      return {
        status: 400,
        body: { error: `Template #${result.templateId} not found` },
      };
    }
    if (result.kind === "needs-mapping") {
      return {
        status: 422,
        body: {
          type: "csv-needs-mapping",
          error:
            "We couldn't auto-detect the columns in this CSV. Save a column mapping via the regular /import flow first, then re-upload here.",
          headers: result.headers,
          sampleRows: result.sampleRows,
          suggestedMapping: result.suggestedMapping,
          fileName: file.name,
        },
      };
    }
    return {
      rows: result.rows,
      errors: result.errors,
      format: "csv",
    };
  }

  if (ext === "ofx" || ext === "qfx") {
    const text = await file.text();
    if (!defaultAccountName) {
      return {
        status: 400,
        body: {
          error:
            "OFX/QFX statements need an explicit accountId — pick the destination Finlynq account before uploading.",
        },
      };
    }
    // Investment dispatch — the legacy parseOfx() returns 0 rows for an
    // <INVSTMTRS> file, so we route those through the canonical investment
    // emitter (matches /api/import/preview behavior).
    const looksLikeInvestment = /<INVSTMTRS\b/i.test(text);
    if (looksLikeInvestment) {
      const isQfx = ext === "qfx";
      const canonical = isQfx
        ? parseQfxToCanonical(text)
        : parseOfxToCanonical(text, "ofx");
      if (canonical.rows.length === 0) {
        return {
          status: 400,
          body: {
            error: "No transactions found in OFX/QFX investment statement.",
          },
        };
      }
      const rows: RawTransaction[] = canonical.rows.map((r) => ({
        ...r,
        account: defaultAccountName,
      }));
      // Investment statements may have multiple per-account balances;
      // surface the first one as the headline statement balance.
      const firstBal = canonical.balances[0];
      return {
        rows,
        errors: [],
        format: ext === "qfx" ? "qfx" : "ofx",
        statementBalance: firstBal?.balanceAmount ?? null,
        statementBalanceDate: firstBal?.balanceDate ?? null,
      };
    }

    // Legacy bank/CC OFX path — extract <LEDGERBAL> for statement balance.
    const ofx = parseOfx(text);
    if (ofx.transactions.length === 0) {
      return {
        status: 400,
        body: { error: "No transactions found in OFX/QFX file" },
      };
    }
    const rows: RawTransaction[] = ofx.transactions.map((t) => ({
      date: t.date,
      account: defaultAccountName,
      amount: t.amount,
      payee: t.payee,
      currency: ofx.currency,
      note: t.memo || "",
      fitId: t.fitId,
    }));
    return {
      rows,
      errors: [],
      format: ext === "qfx" ? "qfx" : "ofx",
      statementBalance: ofx.balanceAmount,
      statementBalanceDate: ofx.balanceDate,
      statementCurrency: ofx.currency,
    };
  }

  return {
    status: 400,
    body: {
      error: `Unsupported file type "${ext ?? "unknown"}". Staging upload supports CSV, OFX, and QFX. For PDF/Excel, use the regular import flow first.`,
    },
  };
}

/** Build accountName → {id, currency} map for the user. Mirrors
 *  buildAccountLookup() in src/lib/reconcile.ts. */
async function buildAccountLookup(
  userId: string,
  dek: Buffer,
): Promise<Map<string, { id: number; currency: string }>> {
  const rows = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.userId, userId))
    .all();
  const map = new Map<string, { id: number; currency: string }>();
  for (const a of rows) {
    const plainName = a.nameCt ? tryDecryptField(dek, a.nameCt, "accounts.name_ct") : null;
    const plainAlias = a.aliasCt ? tryDecryptField(dek, a.aliasCt, "accounts.alias_ct") : null;
    if (plainName) {
      map.set(plainName.toLowerCase().trim(), { id: a.id, currency: a.currency });
    }
    if (plainAlias) {
      const key = plainAlias.toLowerCase().trim();
      if (key && !map.has(key)) map.set(key, { id: a.id, currency: a.currency });
    }
  }
  return map;
}
