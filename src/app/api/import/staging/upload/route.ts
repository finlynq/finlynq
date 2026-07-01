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

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, eq, inArray } from "drizzle-orm";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { decryptName } from "@/lib/crypto/encrypted-columns";
import {
  generateImportHash,
  checkDuplicates,
  checkFitIdDuplicates,
} from "@/lib/import-hash";
import { normalizeDate } from "@/lib/csv-parser";
import { isSupportedCurrency } from "@/lib/fx/supported-currencies";
import type { DateFormatOverride } from "@/lib/csv-parser";
import { findUnreasonableAmountError } from "@/lib/import-pipeline";
import { safeErrorMessage } from "@/lib/validate";
import { advanceStagedImportByMode } from "@/lib/import/advance-by-mode";
import { getConfirmCsvMappingDefault } from "@/app/api/settings/confirm-csv-mapping/route";
// FINLYNQ-221 — the parse + staged-import WRITE core lives in the shared
// stage-statement-file chokepoint (so the MCP `upload_statement` tool stages
// via the identical pipeline). The route imports them back: `parseStatement`
// for the parse step (it needs the parsed rows to make the confirm-gate /
// simplified-path decision), `buildAccountLookup` for the simplified-path
// classifier, and `writeStagedImport` for the detailed-staging INSERT tail.
import {
  parseStatement,
  buildAccountLookup,
  writeStagedImport,
  type ParseSuccess,
} from "@/lib/import/stage-statement-file";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 20 * 1024 * 1024; // 20 MB
/** Hard cap so a single staging session stays cheap to classify + render. */
const MAX_STAGING_ROWS = 10_000;
const DEFAULT_DATE_TOLERANCE_DAYS = 3;

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
    // ─── Unified pipeline (2026-06-30) ───────────────────────────────────
    // ONE path for every account mode: stage the parsed rows into
    // `staged_imports` (writeStagedImport), then advance as far as the bound
    // account's mode dictates via the shared `advanceStagedImportByMode` (the
    // SAME step the SimpleFIN connector uses):
    //   manual  → stays in /import/pending for review
    //   approve → auto-loads to bank_transactions (awaits an /inbox click)
    //   auto    → auto-loads + fires rules → transactions
    // Every row always passes through the staged stage first, so it's visible
    // at each stage and flipping an account's mode only changes how far NEW
    // imports auto-advance. Replaces the former simplified-vs-detailed branch +
    // simplifiedUpload (which skipped the staged stage for approve/auto).
    const staged = await writeStagedImport(parseResult, {
      userId,
      dek,
      accountId,
      fileName: file.name,
      knobs: { skipHeaderRows, skipFooterRows, dateFormatOverride, defaultCurrency },
      boundAccountCurrency,
      userStatementBalance,
    });

    // approve/auto need a bound account; boundAccountMode is null when
    // accountId is null (cross-account CSV) → the import stays in pending.
    const advance =
      accountId !== null
        ? await advanceStagedImportByMode({
            userId,
            dek,
            stagedImportId: staged.stagedImportId,
            accountId,
            mode: boundAccountMode ?? undefined,
          })
        : null;

    const reachedLedger = advance != null && advance.stage !== "pending";
    return NextResponse.json({
      stagedImportId: staged.stagedImportId,
      redirectTo: reachedLedger
        ? `/reconcile?account=${accountId}`
        : `/import/pending?id=${encodeURIComponent(staged.stagedImportId)}`,
      format: staged.format,
      // §A — echo the resolved OFX payee source. Undefined for CSV.
      ...(parseResult.payeeSource ? { payeeSource: parseResult.payeeSource } : {}),
      counts: {
        new: staged.counts.new,
        existing: staged.counts.existing,
        probableDuplicate: staged.counts.probableDuplicate,
        skippedDuplicate: staged.counts.skippedDuplicate,
        errors: staged.counts.errors,
        // Auto-pilot only — feeds the drawer's after-toast
        // ("5 of 12 rows auto-categorized").
        ...(advance && advance.mode === "auto"
          ? {
              autoRule: {
                matched: advance.recorded,
                unmatched: Math.max(
                  0,
                  advance.promoted - advance.recorded - advance.possibleDuplicates,
                ),
                possibleDuplicates: advance.possibleDuplicates,
                total: advance.promoted,
              },
            }
          : {}),
      },
      statement: buildStatementSummary(parseResult),
      tolerance,
      rowErrors,
      // Furthest stage the rows reached: pending | loaded | recorded.
      ...(advance ? { advanced: { mode: advance.mode, stage: advance.stage } } : {}),
    });
  } catch (error) {
    const message = safeErrorMessage(error, "Staging upload failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
