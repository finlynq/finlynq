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
 *
 * Returns:
 *   { stagedImportId, redirectTo, format, counts, tolerance }   // HTTP 200
 *
 * Encryption tier: uploads happen inside an authenticated session, so the
 * DEK is available — staged rows land directly at `encryption_tier='user'`
 * (v1: envelope under the user's DEK). Email-import staging stays at
 * `encryption_tier='service'` (PF_STAGING_KEY) because the webhook has no
 * DEK; the login-time upgrade job converts those rows on the next login.
 *
 * `import_hash` is computed at ingest from plaintext payee — load-bearing
 * per CLAUDE.md (the hash is dedup-stable and must NEVER be recomputed).
 *
 * Already-imported marker: every newly-staged row is probed against
 * `bank_transactions.import_hash` for the same user (dedup source moved
 * from `transactions` in the 2026-05-22 two-ledger refactor — a deleted
 * system-side transaction no longer creates a re-import gap); hits land at
 * `reconcile_state='skipped_duplicate'` (default-excluded from approve).
 * Re-uploading an identical file produces a staged batch whose rows are
 * all flagged `skipped_duplicate`; the user rejects with one click. Per
 * CLAUDE.md "Do NOT silently flip skipped_duplicate back to unmatched":
 * the marker is only set at INSERT time; subsequent row PATCHes preserve
 * whatever value the user toggled to.
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
import { and, eq, inArray } from "drizzle-orm";
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
// Removed in the 2026-05-22 two-ledger refactor: probable-duplicate fuzzy
// matching (buildDuplicateCandidatePool / detectProbableDuplicates) is no
// longer run at file-upload time. Exact match against bank_transactions
// is the only file-side dedup; fuzzy matching belongs on the bank-ledger
// → transactions reconciliation surface (future).
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

/** Parsed bank balance anchor (2026-05-24). Carried from parser → approve. */
interface ParsedAnchor {
  date: string;          // YYYY-MM-DD
  balance: number;
  currency: string;       // ISO 4217
  source: "csv_column" | "ofx_ledgerbal";
}

interface ParseSuccess {
  rows: RawTransaction[];
  errors: ParseError[];
  format: FileFormat;
  /** OFX only — extracted from <LEDGERBAL>. */
  statementBalance?: number | null;
  statementBalanceDate?: string | null;
  statementCurrency?: string | null;
  /** 2026-05-24 — per-day bank balance anchors. CSV path: extracted from
   *  the Balance column (one per date, last-in-file-order's value).
   *  OFX/QFX path: single anchor synthesized from <LEDGERBAL>. */
  anchors: ParsedAnchor[];
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
      boundAccountCurrency,
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

    // ─── File → bank_transactions dedup (exact-only) ─────────────────────
    //
    // Two-ledger refactor (2026-05-22): file-to-bank-ledger dedup is
    // exact-match only. The previous probable-duplicate (fuzzy) pass
    // queried `transactions` for FX-spread / date-drift heuristics — but
    // that conflated "what the bank reported" with "what's in my live
    // view." Post-refactor:
    //
    //   - File → bank_transactions: exact match only (import_hash + fit_id
    //     via checkDuplicates / checkFitIdDuplicates, both now reading
    //     bank_transactions).
    //   - bank_transactions → transactions: future reconciliation surface
    //     with multiple match strategies (out of scope for this route;
    //     the staged-detail GET surfaces auto-match suggestions between
    //     staged rows and live transactions for the two-pane UI).
    //
    // `dedupStatus` stays a three-value column on staged_transactions for
    // schema stability — the `'probable_duplicate'` value is no longer
    // produced by this route but the DB CHECK constraint still permits it
    // (legacy rows from before the refactor may still carry it).
    const fitIds = shaped.filter((r) => r.fitId).map((r) => r.fitId!);
    const hashes = shaped.filter((r) => r.accountId !== null).map((r) => r.hash);
    const existingFitIds = await checkFitIdDuplicates(fitIds, userId);
    const existingHashes = await checkDuplicates(hashes, userId);

    for (const r of shaped) {
      const isFitHit = !!r.fitId && existingFitIds.has(r.fitId);
      const isHashHit = r.accountId !== null && existingHashes.has(r.hash);
      if (isFitHit || isHashHit) {
        r.dedupStatus = "existing";
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
        // Two-ledger refactor (2026-05-22) — dedup source moved from
        // `transactions.import_hash` to `bank_transactions.import_hash`.
        // A deleted system-side transaction no longer creates a re-import
        // gap; the bank ledger remembers every approved row.
        const hits = await db
          .select({ importHash: schema.bankTransactions.importHash })
          .from(schema.bankTransactions)
          .where(and(
            eq(schema.bankTransactions.userId, userId),
            inArray(schema.bankTransactions.importHash, hashesToProbe),
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

    // ─── Create a new staged_imports row ─────────────────────────────────
    // Two-ledger refactor (2026-05-22) — the F-53E overlap-merge prompt
    // was removed. Re-uploads of an identical file still produce a staged
    // batch, but every row is auto-flagged `reconcile_state='skipped_duplicate'`
    // via the bank-ledger probe above (the `alreadyImportedHashes` set);
    // the user sees "X of N already in your bank ledger" and rejects the
    // batch with one click. Row-level dedup against `bank_transactions`
    // subsumes both the previous "merge into pending batch" and "create
    // alongside" cases.
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
        // 2026-05-24 — per-day bank balance anchors. CSV path: one per
        // unique date with the last-in-file-order's balance. OFX path:
        // single LEDGERBAL anchor. Null when no anchors were parsed —
        // the upload form's typed statement_balance is a separate
        // anchor source carried on the dedicated column above.
        parsedAnchors: parseResult.anchors.length > 0 ? parseResult.anchors : null,
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
  boundAccountCurrency: string | null,
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
      anchorCurrency: boundAccountCurrency,
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
      anchors: result.anchors.map((a) => ({
        date: a.date,
        balance: a.balance,
        currency: a.currency,
        source: "csv_column" as const,
      })),
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
      const anchors: ParsedAnchor[] =
        firstBal?.balanceAmount != null && firstBal?.balanceDate
          ? [{
              date: firstBal.balanceDate,
              balance: firstBal.balanceAmount,
              currency: boundAccountCurrency ?? "CAD",
              source: "ofx_ledgerbal",
            }]
          : [];
      return {
        rows,
        errors: [],
        format: ext === "qfx" ? "qfx" : "ofx",
        statementBalance: firstBal?.balanceAmount ?? null,
        statementBalanceDate: firstBal?.balanceDate ?? null,
        anchors,
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
    const ofxAnchors: ParsedAnchor[] =
      ofx.balanceAmount != null && ofx.balanceDate
        ? [{
            date: ofx.balanceDate,
            balance: ofx.balanceAmount,
            currency: ofx.currency,
            source: "ofx_ledgerbal",
          }]
        : [];
    return {
      rows,
      errors: [],
      format: ext === "qfx" ? "qfx" : "ofx",
      statementBalance: ofx.balanceAmount,
      statementBalanceDate: ofx.balanceDate,
      statementCurrency: ofx.currency,
      anchors: ofxAnchors,
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
