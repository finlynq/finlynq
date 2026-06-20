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
import { encryptStagingMeta } from "@/lib/crypto/staging-metadata";
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
import { findUnreasonableAmountError } from "@/lib/import-pipeline";
import { safeErrorMessage } from "@/lib/validate";
import { simplifiedUpload } from "@/lib/import/simplified-upload";
import { applyRulesToBankRows } from "@/lib/reconcile/match-engine";
import { getConfirmCsvMappingDefault } from "@/app/api/settings/confirm-csv-mapping/route";

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
  /** §A (2026-06-04) — OFX/QFX only — which field was used as the payee
   *  ('name' | 'memo'), echoed back so the upload drawer can confirm what
   *  was applied. Unset for CSV. */
  payeeSource?: "name" | "memo";
}

interface ParseFailure {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Statement summary for the upload-success drawer panel (consolidation
 * follow-up, 2026-06-04): restores the at-upload balance snapshot the old
 * OFX preview surfaced before the drawer skipped straight to staging.
 * Balance prefers the OFX <LEDGERBAL> / typed statement value, else the last
 * parsed anchor; the date range is min/max over the parsed rows (dates are
 * normalized to YYYY-MM-DD so a lexical sort is correct).
 */
function buildStatementSummary(pr: ParseSuccess) {
  const dates = pr.rows
    .map((r) => r.date)
    .filter((d): d is string => typeof d === "string" && d.length > 0)
    .sort();
  const lastAnchor =
    pr.anchors.length > 0 ? pr.anchors[pr.anchors.length - 1] : null;
  return {
    balance: pr.statementBalance ?? lastAnchor?.balance ?? null,
    balanceDate: pr.statementBalanceDate ?? lastAnchor?.date ?? null,
    currency: pr.statementCurrency ?? lastAnchor?.currency ?? null,
    rowCount: pr.rows.length,
    anchorCount: pr.anchors.length,
    dateRange:
      dates.length > 0
        ? { start: dates[0], end: dates[dates.length - 1] }
        : null,
  };
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

    // ─── Statement-upload field-mapping (2026-06-04) ──────────────────────
    // §A — OFX/QFX payee source. Optional per-upload override of the bound
    // account's saved `ofx_payee_source`. Resolved to the saved value below
    // (after the account row is read) when the form doesn't carry one.
    const payeeSourceRaw = formData.get("payeeSource");
    let formPayeeSource: "name" | "memo" | null = null;
    if (payeeSourceRaw && typeof payeeSourceRaw === "string" && payeeSourceRaw.trim()) {
      const v = payeeSourceRaw.trim().toLowerCase();
      if (v !== "name" && v !== "memo") {
        return NextResponse.json(
          { error: "payeeSource must be 'name' or 'memo'" },
          { status: 400 },
        );
      }
      formPayeeSource = v;
    }

    // §B — when the user has confirmed/edited a CSV mapping in the
    // ColumnMappingDialog, the drawer re-fires with an explicit `templateId`
    // (the saved template). That explicit template takes the parsed path in
    // the pipeline (step 1), so we must NOT re-gate the confirm flow.
    // `confirmedMapping=1` lets a future inline-mapping path opt out too,
    // but today the templateId presence is the signal.
    const confirmedMappingRaw = formData.get("confirmedMapping");
    const confirmedMapping =
      typeof confirmedMappingRaw === "string" && confirmedMappingRaw === "1";

    // §A (2026-06-04) — OFX/QFX confirm preview re-fire flag. The OfxConfirmDialog
    // re-uploads with `confirmedImport=1` (+ the chosen payeeSource) so the
    // route stages instead of returning the preview again.
    const confirmedImportRaw = formData.get("confirmedImport");
    const confirmedImport =
      typeof confirmedImportRaw === "string" && confirmedImportRaw === "1";

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
    //
    // Inbox v4 Phase 3 (2026-05-27): also read `accounts.mode` so we can
    // override the per-template `import_mode` for Approve-each accounts
    // (see the simplified-branch block below).
    let defaultAccountName: string | null = null;
    let boundAccountCurrency: string | null = null;
    let boundAccountMode: "auto" | "approve" | "manual" | null = null;
    // Statement-upload field-mapping (2026-06-04). Per-account import knobs.
    let boundAccountOfxPayeeSource: "name" | "memo" = "name";
    let boundAccountCsvMappingMode: "confirm" | "auto" = "confirm";
    if (accountId !== null) {
      const acct = await db
        .select({
          id: schema.accounts.id,
          nameCt: schema.accounts.nameCt,
          currency: schema.accounts.currency,
          mode: schema.accounts.mode,
          ofxPayeeSource: schema.accounts.ofxPayeeSource,
          csvMappingMode: schema.accounts.csvMappingMode,
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
      boundAccountMode = acct.mode;
      boundAccountOfxPayeeSource =
        acct.ofxPayeeSource === "memo" ? "memo" : "name";
      boundAccountCsvMappingMode =
        acct.csvMappingMode === "auto" ? "auto" : "confirm";
    }

    const ext = file.name.split(".").pop()?.toLowerCase();
    // §A — effective OFX payee source: the per-upload form override wins,
    // else the bound account's saved preference (default 'name').
    const effectivePayeeSource: "name" | "memo" =
      formPayeeSource ?? boundAccountOfxPayeeSource;
    // Two-layer confirm decision (one setting governs BOTH CSV column-mapping
    // §B and OFX/QFX field-mapping §A). The per-account `csv_mapping_mode`
    // column is the override; the per-user `confirm_csv_mapping` setting is the
    // default:
    //   - account === 'auto'   → explicit opt-out → ALWAYS silent.
    //   - account === 'confirm'→ follow the per-user default (ON ⇒ confirm;
    //                            OFF ⇒ silent).
    // The account column defaults to 'confirm' for every account (existing +
    // new), so the global switch is what makes "OFF = silent everywhere except
    // accounts explicitly set back" work without a schema flag for "never set."
    // Gated on a bound account (cross-account CSV without a binding has no
    // per-account preference). `/api/import/preview` never reaches here.
    let confirmImportsBase = false;
    if (accountId !== null && boundAccountCsvMappingMode === "confirm") {
      confirmImportsBase = await getConfirmCsvMappingDefault(userId);
    }
    // §B CSV gate — also suppressed once the user has confirmed/edited the
    // mapping (it re-fires with an explicit templateId, taking the parsed path).
    const confirmAutoMapping =
      confirmImportsBase && templateId === null && !confirmedMapping;
    // §A OFX/QFX gate — suppressed once the user confirmed the field-mapping
    // preview (re-fires with confirmedImport=1 + the chosen payeeSource).
    const confirmOfxPreview = confirmImportsBase && !confirmedImport;
    const parseResult = await parseStatement(
      file,
      ext,
      templateId,
      userId,
      defaultAccountName,
      { skipHeaderRows, skipFooterRows, dateFormatOverride, defaultCurrency },
      boundAccountCurrency,
      {
        payeeSource: effectivePayeeSource,
        confirmAutoMapping,
        confirmOfxPreview,
        fileName: file.name,
      },
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

    // FINLYNQ-159 / FINLYNQ-195 — reject non-finite / absurd-magnitude numeric
    // fields (amount, entered amount, AND the investment QUANTITY) before any
    // row lands in staging. The staging-upload path does NOT route through
    // previewImport (whose per-row loop applies the same check), so enforce the
    // finite / sane bound here exactly like the OFX/QFX/IBKR direct-emit
    // branches in /api/import/preview. Covers a garbage qty (e.g. 1e29) on an
    // investment CSV. Returns 400, never stages.
    const amountErr = findUnreasonableAmountError(parseResult.rows);
    if (amountErr) {
      return NextResponse.json({ error: amountErr }, { status: 400 });
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
      // FINLYNQ-195 — security TICKER/SYMBOL mapped on investment-account imports.
      ticker?: string;
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
        ticker: row.ticker,
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

    // ─── Phase 2 of import-modes refactor (2026-05-25): simplified branch ──
    //
    // If the selected template is in `import_mode='simplified'`, skip the
    // staged review and land rows directly in bank_transactions. The user
    // goes straight to /reconcile to categorize.
    //
    // Inbox v4 Phase 3 (2026-05-27): the Approve-each account policy
    // (`accounts.mode='approve'`) ALSO triggers the simplified path, even
    // if the picked template is in `import_mode='detailed'`. The account-
    // level policy override is intentional — Approve-each means "I trust
    // the parser, but I want one click between bank-ledger and the real
    // ledger entry." Detailed-staging would add a redundant parse-review
    // gate before the card flow takes over on /inbox.
    //
    // Rules do NOT fire here — that's Phase 4 (Auto-pilot). The bank rows
    // wait on /inbox's "To approve" tab; the user (or "Accept all
    // suggested") commits each to the ledger via POST /approve.
    //
    // Preconditions:
    //   - accountId must be set (bank-ledger uniqueness key is per-account).
    //   - For the template-based simplified path: templateId must be set
    //     (auto-detect stays on detailed for now).
    //   - Row errors are still surfaced (we don't silently drop bad rows).
    //
    // The detailed path below remains the default and handles every case
    // where the account is Manual and the template is Detailed (or no
    // template is selected).
    let useSimplifiedPath = false;
    if (boundAccountMode === "approve" || boundAccountMode === "auto") {
      // Account-policy override: Approve-each + Auto-pilot accounts always
      // use the simplified path regardless of the per-template import_mode
      // setting. Inbox v4 Phase 3 covers Approve-each; Phase 4 extends to
      // Auto-pilot — both lenses skip the staged-review gate, but the
      // post-bank-write step differs (Auto-pilot fires rules; Approve-each
      // just waits for a click).
      if (accountId === null) {
        // boundAccountMode is only set when accountId is non-null, so this
        // is unreachable — kept as a defensive guard so the TS narrowing
        // below stays unambiguous.
        return NextResponse.json(
          { error: "Auto-pilot / Approve-each accounts require accountId." },
          { status: 400 },
        );
      }
      useSimplifiedPath = true;
    } else if (templateId !== null) {
      const tplRow = await db
        .select({ importMode: schema.importTemplates.importMode })
        .from(schema.importTemplates)
        .where(and(
          eq(schema.importTemplates.id, templateId),
          eq(schema.importTemplates.userId, userId),
        ))
        .get();
      if (tplRow?.importMode === "simplified") {
        if (accountId === null) {
          return NextResponse.json(
            {
              error:
                "Simplified mode requires a bound account. Pick an account when uploading, or switch the template to Detailed.",
            },
            { status: 400 },
          );
        }
        useSimplifiedPath = true;
      }
    }

    if (useSimplifiedPath && accountId !== null) {
      try {
        const result = await simplifiedUpload({
          userId,
          dek,
          accountId,
          templateId,
          rows: shaped.map((r) => ({
            rowIndex: r.rowIndex,
            date: r.date,
            amount: r.amount,
            currency: r.currency ?? defaultCurrency ?? boundAccountCurrency ?? "CAD",
            payee: r.payee,
            note: r.note ?? null,
            tags: r.tags ?? null,
            accountName: r.account || null,
            fitId: r.fitId ?? null,
            enteredAmount: r.enteredAmount ?? null,
            enteredCurrency: r.enteredCurrency ?? defaultCurrency ?? null,
            enteredFxRate: null,
            quantity: r.quantity ?? null,
            // FINLYNQ-195 — investment-import capture. PLAINTEXT here; the
            // bank-ledger writer encrypts at the row's tier (like payee).
            ticker: r.ticker ?? null,
            securityName: r.portfolioHolding ?? null,
            importHash: r.hash,
          })),
          anchors: parseResult.anchors,
          filename: file.name,
          source: "upload",
        });

        // ─── Inbox v4 Phase 4 (2026-05-27) — Auto-pilot rule firing ─────
        //
        // For Auto-pilot accounts, fire user-configured transaction-rules
        // against the bank rows we just upserted. Rule-matched rows are
        // materialized to `transactions` with `source='auto_rule'` inside
        // the helper; unmatched rows stay in `bank_transactions` and show
        // up in /inbox's "To categorize" tab.
        //
        // Idempotent: re-running on the same batch (re-upload of the same
        // file) silently skips rows whose `transaction_bank_links` row
        // already exists, so the helper never duplicates ledger entries.
        //
        // Fired AFTER simplifiedUpload returns rather than threaded into
        // its transaction because: (1) the helper opens its own
        // per-bank-row tx so a single bad row doesn't roll back the
        // entire batch ingest; (2) simplifiedUpload doesn't return the
        // inserted ids today and threading them out would couple the two
        // module surfaces unnecessarily. Bank-row ids are looked up by
        // `upload_batch_id` instead — cheap single-account-scoped SELECT.
        let autoRuleStats: {
          matched: number;
          unmatched: number;
          possibleDuplicates: number;
          total: number;
        } | null = null;
        if (boundAccountMode === "auto") {
          const insertedBankRows = await db
            .select({ id: schema.bankTransactions.id })
            .from(schema.bankTransactions)
            .where(
              and(
                eq(schema.bankTransactions.userId, userId),
                eq(schema.bankTransactions.uploadBatchId, result.batchId),
              ),
            )
            .all();
          const bankRowIds = insertedBankRows.map((r) => r.id);
          if (bankRowIds.length > 0) {
            const ruleResult = await applyRulesToBankRows(
              userId,
              bankRowIds,
              dek,
              { autoMaterialize: true },
            );
            autoRuleStats = {
              matched: ruleResult.materialized,
              unmatched:
                bankRowIds.length -
                ruleResult.materialized -
                ruleResult.possibleDuplicates,
              possibleDuplicates: ruleResult.possibleDuplicates,
              total: bankRowIds.length,
            };
          } else {
            autoRuleStats = {
              matched: 0,
              unmatched: 0,
              possibleDuplicates: 0,
              total: 0,
            };
          }
        }

        return NextResponse.json({
          mode: result.mode,
          batchId: result.batchId,
          redirectTo: result.redirectTo,
          format: parseResult.format,
          // §A — echo the resolved OFX payee source so the drawer can confirm
          // which field populated the payee. Undefined for CSV.
          ...(parseResult.payeeSource ? { payeeSource: parseResult.payeeSource } : {}),
          counts: {
            created: result.created,
            skippedDuplicates: result.skippedDuplicates,
            anchorsUpserted: result.anchorsUpserted,
            // Phase 4 — populated only on Auto-pilot accounts. Surfaces
            // the rule-fire results so the UploadDrawer's after-toast can
            // say "5 of 12 rows auto-categorized."
            ...(autoRuleStats ? { autoRule: autoRuleStats } : {}),
          },
          statement: buildStatementSummary(parseResult),
          rowErrors,
        });
      } catch (err) {

        console.error("[upload] simplifiedUpload failed", { userId, templateId, err });
        return NextResponse.json(
          { error: safeErrorMessage(err, "Simplified upload failed") },
          { status: 500 },
        );
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
      // FINLYNQ-195 — investment-import capture (v1). TICKER + security NAME are
      // SENSITIVE free-text, so encrypt-in-place under the user's DEK (v1:
      // envelope) exactly like payee/category/note above. Read paths branch on
      // encryption_tier per row (staged/[id] GET). NULL for cash-account rows
      // (mapping never sets ticker/portfolioHolding for non-investment imports).
      // The portfolioHolding name maps to the new `securityName` column.
      ticker: encryptField(dek, r.ticker ?? null),
      securityName: encryptField(dek, r.portfolioHolding ?? null),
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
        // FINLYNQ-120 — web upload carries a session DEK, so filename lands at
        // USER tier (v1:). fromAddress/subject/sampleRows are null on this path.
        originalFilename: encryptStagingMeta(file.name, "user", dek),
        encryptionTier: "user",
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

      // Phase 3 of import-modes refactor (2026-05-25) — rules no longer fire
      // at upload time. Categorization happens at /reconcile materialize
      // time (via match-engine.ts:364 applyRules suggestion + dialog confirm).
      // The detailed-mode /import/pending review is now parse-verification
      // only; approve writes ONLY to bank_transactions.
    });

    return NextResponse.json({
      stagedImportId,
      redirectTo: `/import/pending?id=${encodeURIComponent(stagedImportId)}`,
      format: parseResult.format,
      // §A — echo the resolved OFX payee source. Undefined for CSV.
      ...(parseResult.payeeSource ? { payeeSource: parseResult.payeeSource } : {}),
      counts: {
        new: shaped.filter((r) => r.dedupStatus === "new").length,
        existing: shaped.filter((r) => r.dedupStatus === "existing").length,
        probableDuplicate: shaped.filter((r) => r.dedupStatus === "probable_duplicate").length,
        skippedDuplicate: shaped.filter((r) => alreadyImportedHashes.has(r.hash)).length,
        errors: rowErrors.length + parseResult.errors.length,
      },
      statement: buildStatementSummary(parseResult),
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
    defaultCurrency: string | null;
  },
  boundAccountCurrency: string | null,
  // Statement-upload field-mapping (2026-06-04). §A payeeSource governs which
  // OFX/QFX field becomes the payee; §B confirmAutoMapping gates the CSV
  // auto-detect confirm flow. Defaults preserve today's behavior so the
  // (unaffected) /api/import/preview path stays silent.
  fieldMapping: {
    payeeSource: "name" | "memo";
    confirmAutoMapping: boolean;
    confirmOfxPreview?: boolean;
    fileName: string;
  } = { payeeSource: "name", confirmAutoMapping: false, fileName: file.name },
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
      defaultCurrency: knobs.defaultCurrency,
      anchorCurrency: boundAccountCurrency,
      confirmAutoMapping: fieldMapping.confirmAutoMapping,
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
    if (result.kind === "auto-detected") {
      // §B — the pipeline detected a mapping but the account is in 'confirm'
      // mode. Surface it for review before staging (mirrors the
      // csv-needs-mapping 422, with the detected mapping + source pre-filled).
      return {
        status: 422,
        body: {
          type: "csv-confirm-mapping",
          error:
            "Confirm the detected column mapping before importing this CSV.",
          headers: result.headers,
          sampleRows: result.sampleRows,
          suggestedMapping: result.mapping,
          source: result.source,
          ...(result.templateId != null ? { templateId: result.templateId } : {}),
          rowCount: result.rowCount,
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
      // payeeSource only affects bank/CC <STMTTRN> rows — investment legs
      // synthesize their own payees, so passing it here is a harmless no-op
      // for the trade/income/transfer rows (kept for symmetry).
      const canonical = isQfx
        ? parseQfxToCanonical(text, { payeeSource: fieldMapping.payeeSource })
        : parseOfxToCanonical(text, "ofx", { payeeSource: fieldMapping.payeeSource });
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
        payeeSource: fieldMapping.payeeSource,
      };
    }

    // Legacy bank/CC OFX path — extract <LEDGERBAL> for statement balance.
    // §A — payeeSource selects which OFX field (NAME vs MEMO) becomes the
    // payee; `t.payee` / `t.memo` already reflect that choice in the parser.
    const ofx = parseOfx(text, { payeeSource: fieldMapping.payeeSource });
    if (ofx.transactions.length === 0) {
      return {
        status: 400,
        body: { error: "No transactions found in OFX/QFX file" },
      };
    }
    // §A (2026-06-04) — field-mapping confirm preview. When the account is in
    // 'confirm' mode (and the upload isn't the post-confirm re-fire), return the
    // parsed rows as a preview INSTEAD of staging. The OfxConfirmDialog shows
    // them with a live Name/Memo payee-source toggle; on confirm the drawer
    // re-uploads with `confirmedImport=1` + the chosen payeeSource. Mirrors the
    // CSV csv-confirm-mapping 422. Investment statements (handled above) have no
    // NAME/MEMO choice, so they're never gated here.
    if (fieldMapping.confirmOfxPreview) {
      return {
        status: 422,
        body: {
          type: "ofx-confirm",
          error: "Confirm how this statement maps before importing.",
          format: ext === "qfx" ? "qfx" : "ofx",
          payeeSource: fieldMapping.payeeSource,
          account: defaultAccountName,
          currency: ofx.currency,
          statementBalance: ofx.balanceAmount,
          statementBalanceDate: ofx.balanceDate,
          rowCount: ofx.transactions.length,
          // Raw NAME + MEMO per row so the dialog can live-swap payee/note
          // client-side without re-uploading on every toggle.
          rows: ofx.transactions.map((t) => ({
            date: t.date,
            amount: t.amount,
            name: t.name,
            memo: t.rawMemo,
            type: t.type,
            fitId: t.fitId,
          })),
          fileName: file.name,
        },
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
      payeeSource: fieldMapping.payeeSource,
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
