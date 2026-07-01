/**
 * stageStatementFile — shared "parse a statement file → create a staged_imports
 * row (+ staged_transactions)" chokepoint (FINLYNQ-221 / R-08).
 *
 * DRY-extracted from the inline detailed-staging body of
 * `src/app/api/import/staging/upload/route.ts` so the web upload route AND the
 * new `upload_statement` MCP tool share ONE chokepoint — mirrors the
 * FINLYNQ-220 `sendStagedRowsToBankLedger` and FINLYNQ-150
 * `materializeBankRowAsTransaction` patterns. Duplicating the parse → classify
 * → dedup → INSERT pipeline in the MCP tool would create a second drift point.
 *
 * IMPORTANT divergence (per the ticket): the existing `POST /api/mcp/upload`
 * produces the WRONG artifact (a file on disk + `mcp_uploads` row consumed by
 * `preview_import`/`execute_import`). R-08 runs THIS staging pipeline so the
 * returned `stagedImportId` is a real `staged_imports.id` that
 * `send_to_bank_ledger` (R-07) + `approve_staged_rows` consume unchanged.
 *
 * Two seams:
 *   - `parseStatement(file, …)` — parse CSV/OFX/QFX into canonical rows +
 *     balance anchors. Shared with the web route (which imports it back).
 *   - `writeStagedImport(parseResult, ctx)` — classify rows (new / existing)
 *     against bank_transactions, run the already-imported probe, and INSERT the
 *     staged_imports + staged_transactions rows under the user's DEK. The web
 *     route's detailed-staging tail delegates here so the write lives in ONE
 *     place; `stageStatementFile` composes parse + write for the MCP tool.
 *
 * The MCP path is autonomous (no UI), so `stageStatementFile` always takes the
 * detailed-staging path with auto-detected mapping — no confirm-mapping gates,
 * no simplified bank-ledger-direct path (those are HTTP-form-only flows the
 * route resolves BEFORE delegating to `writeStagedImport`).
 *
 * Load-bearing rules honored (CLAUDE.md / docs/invariants.md):
 *   - import_hash computed over PLAINTEXT payee at ingest (dedup-stable, never
 *     recomputed by a read path; the resolved accountId is recomputed at
 *     send-to-bank-ledger time).
 *   - findUnreasonableAmountError(rows) gate (FINLYNQ-159) — the staging path
 *     bypasses previewImport's per-row check, so it runs the scanner here.
 *   - Staged rows land at encryption_tier='user' (v1: under the DEK); read
 *     paths branch per-row on encryption_tier.
 *   - Owner-scoped: accountId must belong to userId.
 *   - Re-uploading the same file creates a NEW staged_imports row (dedup is
 *     row-level, not file-level — known rows are flagged 'existing').
 */

import { randomUUID } from "crypto";
import { db, schema } from "@/db";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { decryptName } from "@/lib/crypto/encrypted-columns";
import { encryptField, tryDecryptField } from "@/lib/crypto/envelope";
import { encryptStagingMeta } from "@/lib/crypto/staging-metadata";
import {
  generateImportHash,
  checkDuplicates,
  checkFitIdDuplicates,
  checkFitIdDuplicatesForAccount,
} from "@/lib/import-hash";
import { normalizeDate } from "@/lib/csv-parser";
import { parseOfx } from "@/lib/ofx-parser";
import {
  parseCsvWithFallback,
  type ParseError,
} from "@/lib/external-import/parsers/csv-pipeline";
import type { DateFormatOverride } from "@/lib/csv-parser";
import { parseOfxToCanonical } from "@/lib/external-import/parsers/ofx";
import { parseQfxToCanonical } from "@/lib/external-import/parsers/qfx";
import type { RawTransaction } from "@/lib/import-pipeline";
import { findUnreasonableAmountError } from "@/lib/import-pipeline";

/** 60 days — matches the route + stage-email-import.ts. */
const STAGE_TTL_MS = 60 * 24 * 60 * 60 * 1000;

/** "YYYY-MM-DD" → whole-day epoch number (UTC), or null if unparseable. */
function isoToEpochDay(iso: string): number | null {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(t) ? null : Math.floor(t / 86_400_000);
}

/** Shift a "YYYY-MM-DD" by ±days, returning "YYYY-MM-DD". */
function shiftIsoDate(iso: string, deltaDays: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return new Date(t + deltaDays * 86_400_000).toISOString().slice(0, 10);
}
/** Hard cap so a single staging session stays cheap to classify + render. */
const MAX_STAGING_ROWS = 10_000;

export type StatementFileFormat = "csv" | "ofx" | "qfx";

/** Parsed bank balance anchor. Carried from parser → staged_imports.parsed_anchors. */
export interface ParsedAnchor {
  date: string; // YYYY-MM-DD
  balance: number;
  currency: string; // ISO 4217
  source: "csv_column" | "ofx_ledgerbal";
}

export interface ParseSuccess {
  rows: RawTransaction[];
  errors: ParseError[];
  format: StatementFileFormat;
  statementBalance?: number | null;
  statementBalanceDate?: string | null;
  statementCurrency?: string | null;
  anchors: ParsedAnchor[];
  payeeSource?: "name" | "memo";
}

export interface ParseFailure {
  /** HTTP-style status the web route maps back to a NextResponse. */
  status: number;
  body: Record<string, unknown>;
}

export interface ParseStatementKnobs {
  skipHeaderRows: number;
  skipFooterRows: number;
  dateFormatOverride: DateFormatOverride | null;
  defaultCurrency: string | null;
}

export interface ParseStatementFieldMapping {
  payeeSource: "name" | "memo";
  confirmAutoMapping: boolean;
  confirmOfxPreview?: boolean;
  fileName: string;
}

/**
 * Parse a statement File (CSV / OFX / QFX) into canonical rows + balance
 * anchors. Exported so the web upload route + the staging chokepoint share ONE
 * parse path. Returns a ParseFailure (status + body) for unsupported types /
 * confirm-mapping previews / parse misses — callers map it to their transport.
 */
export async function parseStatement(
  file: File,
  ext: string | undefined,
  templateId: number | null,
  userId: string,
  defaultAccountName: string | null,
  knobs: ParseStatementKnobs,
  boundAccountCurrency: string | null,
  fieldMapping: ParseStatementFieldMapping = {
    payeeSource: "name",
    confirmAutoMapping: false,
    fileName: "",
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
    // Investment dispatch — legacy parseOfx() returns 0 rows for an
    // <INVSTMTRS> file, so route those through the canonical investment emitter.
    const looksLikeInvestment = /<INVSTMTRS\b/i.test(text);
    if (looksLikeInvestment) {
      const isQfx = ext === "qfx";
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
      const firstBal = canonical.balances[0];
      const anchors: ParsedAnchor[] =
        firstBal?.balanceAmount != null && firstBal?.balanceDate
          ? [
              {
                date: firstBal.balanceDate,
                balance: firstBal.balanceAmount,
                currency: boundAccountCurrency ?? "CAD",
                source: "ofx_ledgerbal",
              },
            ]
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
    const ofx = parseOfx(text, { payeeSource: fieldMapping.payeeSource });
    if (ofx.transactions.length === 0) {
      return {
        status: 400,
        body: { error: "No transactions found in OFX/QFX file" },
      };
    }
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
        ? [
            {
              date: ofx.balanceDate,
              balance: ofx.balanceAmount,
              currency: ofx.currency,
              source: "ofx_ledgerbal",
            },
          ]
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
      // FINLYNQ-221 — the `unsupported-format` discriminator lets the MCP tool
      // report detectedFormat:'unrecognised' on an unsupported extension.
      type: "unsupported-format",
      error: `Unsupported file type "${ext ?? "unknown"}". Staging upload supports CSV, OFX, and QFX. For PDF/Excel, use the regular import flow first.`,
    },
  };
}

/** Build accountName → {id, currency} map for the user. Mirrors the route. */
export async function buildAccountLookup(
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
    const plainName = a.nameCt
      ? tryDecryptField(dek, a.nameCt, "accounts.name_ct")
      : null;
    const plainAlias = a.aliasCt
      ? tryDecryptField(dek, a.aliasCt, "accounts.alias_ct")
      : null;
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

export interface StageStatementCounts {
  new: number;
  existing: number;
  probableDuplicate: number;
  skippedDuplicate: number;
  errors: number;
}

export interface StageStatementSuccess {
  ok: true;
  stagedImportId: string;
  format: StatementFileFormat;
  rowCount: number;
  duplicateCount: number;
  newCount: number;
  dateStart: string | null;
  dateEnd: string | null;
  statementBalance: number | null;
  statementBalanceDate: string | null;
  statementCurrency: string | null;
  counts: StageStatementCounts;
  rowErrors: Array<{ rowIndex: number; message: string }>;
}

/**
 * Context the staged-import writer needs beyond the parsed rows. Mirrors the
 * route's locals so BOTH the web route and stageStatementFile feed it the same
 * shape — the single drift-free chokepoint for the staged_imports +
 * staged_transactions write.
 */
export interface WriteStagedImportContext {
  userId: string;
  dek: Buffer;
  /** Bound account id (null for cross-account CSV without a binding). */
  accountId: number | null;
  /** Original filename (display only — encrypted at the user tier). */
  fileName: string;
  /** Parser knobs persisted onto staged_imports. */
  knobs: ParseStatementKnobs;
  /** Bound-account currency (CSV fallback). */
  boundAccountCurrency: string | null;
  /** User-typed statement balance (CSV form field). */
  userStatementBalance?: number | null;
  /** staged_imports.source — default "upload". Live connectors pass "connector". */
  source?: string;
  /** Override staged_imports.fileFormat (default parseResult.format). Connectors
   *  pass a provider tag (e.g. "simplefin") so the pending list labels them. */
  fileFormatOverride?: string | null;
  /**
   * When set (live bank feeds), a still-`new` row is additionally marked
   * `existing` (skipped by default) if the bound account already has a
   * transaction OR bank-ledger row with the same amount within ±this many days
   * — even under a different payee. This is the feed "auto-skip duplicates I
   * already have" pass; it's re-derived every sync (no stored state), and a
   * false match can still be force-loaded. Off (undefined) for file uploads.
   */
  fuzzyDedupWindowDays?: number;
}

/**
 * The staged-import WRITE core: classify rows (new / existing) against
 * bank_transactions, run the already-imported probe, and INSERT the
 * staged_imports + staged_transactions rows under the user's DEK. Shared by the
 * web upload route's detailed-staging tail AND stageStatementFile so the
 * staging write lives in ONE place.
 *
 * Caller is responsible for parsing (→ ParseSuccess) and any pre-write gates
 * (confirm-mapping previews / simplified path) — by the time this runs, those
 * decisions are resolved and the import always lands as a detailed staged row.
 */
export async function writeStagedImport(
  parseResult: ParseSuccess,
  ctx: WriteStagedImportContext,
): Promise<StageStatementSuccess> {
  const { userId, dek, accountId, knobs, boundAccountCurrency } = ctx;

  // ─── Classify rows ───────────────────────────────────────────────────────
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
    // Fall back to the bound accountId when the row carries no Account column
    // (OFX/QFX always; CSV without an Account column) so the dedup hash + the
    // already-imported probe key on the real account, not 0.
    const resolvedAccountId = acct?.id ?? accountId ?? null;
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

  // ─── File → bank_transactions dedup (exact-only) ─────────────────────────
  const fitIds = shaped.filter((r) => r.fitId).map((r) => r.fitId!);
  const hashes = shaped.filter((r) => r.accountId !== null).map((r) => r.hash);
  // Bank transaction ids are unique only WITHIN an account (SimpleFIN reuses the
  // posted-epoch as the id, so accounts collide) — scope the fitId check to the
  // bound account when there is one; fall back to user-scope for unbound CSVs.
  const existingFitIds =
    accountId !== null
      ? await checkFitIdDuplicatesForAccount(fitIds, userId, accountId)
      : await checkFitIdDuplicates(fitIds, userId);
  const existingHashes = await checkDuplicates(hashes, userId);

  for (const r of shaped) {
    const isFitHit = !!r.fitId && existingFitIds.has(r.fitId);
    const isHashHit = r.accountId !== null && existingHashes.has(r.hash);
    if (isFitHit || isHashHit) {
      r.dedupStatus = "existing";
    }
  }

  // ─── Feed fuzzy dedup (opt-in via fuzzyDedupWindowDays) ───────────────────
  // A live feed often restates a transaction the user already has under a
  // DIFFERENT payee ("Interest Income" vs "Deposit interest"), which exact
  // hash/fitId can't connect. Mark a still-'new' row 'existing' (skipped) when
  // the bound account already has a ledger transaction OR bank-ledger row with
  // the SAME amount within ±window days. Re-derived every sync → a match stays
  // skipped with no stored state; a false positive can still be force-loaded.
  const fuzzySkip = new Set<number>();
  if (ctx.fuzzyDedupWindowDays != null && accountId !== null) {
    const windowDays = ctx.fuzzyDedupWindowDays;
    const candidates = shaped.filter(
      (r) => r.dedupStatus === "new" && r.accountId === accountId,
    );
    if (candidates.length > 0) {
      const sortedDates = candidates.map((r) => r.date).sort();
      const lo = shiftIsoDate(sortedDates[0], -windowDays);
      const hi = shiftIsoDate(sortedDates[sortedDates.length - 1], windowDays);
      const [txRows, bankRows] = await Promise.all([
        db
          .select({ date: schema.transactions.date, amount: schema.transactions.amount })
          .from(schema.transactions)
          .where(and(
            eq(schema.transactions.userId, userId),
            eq(schema.transactions.accountId, accountId),
            gte(schema.transactions.date, lo),
            lte(schema.transactions.date, hi),
          ))
          .all(),
        db
          .select({ date: schema.bankTransactions.date, amount: schema.bankTransactions.amount })
          .from(schema.bankTransactions)
          .where(and(
            eq(schema.bankTransactions.userId, userId),
            eq(schema.bankTransactions.accountId, accountId),
            gte(schema.bankTransactions.date, lo),
            lte(schema.bankTransactions.date, hi),
          ))
          .all(),
      ]);
      // amount(cents) → sorted epoch-day list of existing rows.
      const byAmount = new Map<string, number[]>();
      for (const e of [...txRows, ...bankRows]) {
        const day = isoToEpochDay(e.date);
        if (day == null) continue;
        const key = e.amount.toFixed(2);
        const arr = byAmount.get(key);
        if (arr) arr.push(day);
        else byAmount.set(key, [day]);
      }
      for (const r of candidates) {
        const days = byAmount.get(r.amount.toFixed(2));
        if (!days) continue;
        const rd = isoToEpochDay(r.date);
        if (rd == null) continue;
        if (days.some((d) => Math.abs(d - rd) <= windowDays)) {
          r.dedupStatus = "existing";
          fuzzySkip.add(r.rowIndex);
        }
      }
    }
  }

  // Period-bounds for staged_imports — derived from the parsed rows.
  const allDates = shaped.map((r) => r.date).sort();
  const statementPeriodStart = allDates[0] ?? null;
  const statementPeriodEnd = allDates[allDates.length - 1] ?? null;
  const dateRangeStart = statementPeriodStart;
  const dateRangeEnd = statementPeriodEnd;

  // ─── Already-imported probe (per row) ────────────────────────────────────
  // Hits land at reconcile_state='skipped_duplicate' so approve excludes them
  // by default. Skips when accountId is null (hash needs a stable account key).
  const alreadyImportedHashes = new Set<string>();
  if (accountId !== null) {
    const hashesToProbe = shaped
      .filter((r) => r.accountId !== null)
      .map((r) => r.hash);
    if (hashesToProbe.length > 0) {
      const hits = await db
        .select({ importHash: schema.bankTransactions.importHash })
        .from(schema.bankTransactions)
        .where(
          and(
            eq(schema.bankTransactions.userId, userId),
            inArray(schema.bankTransactions.importHash, hashesToProbe),
          ),
        )
        .all();
      for (const h of hits) {
        if (h.importHash) alreadyImportedHashes.add(h.importHash);
      }
    }
  }

  // ─── Build + write the staged_imports + staged_transactions rows ─────────
  const statementBalance =
    parseResult.statementBalance ?? ctx.userStatementBalance ?? null;
  const statementBalanceDate =
    parseResult.statementBalanceDate ?? statementPeriodEnd ?? null;
  const statementCurrency =
    parseResult.statementCurrency ?? boundAccountCurrency ?? null;

  const txTypeFor = (amount: number): "E" | "I" => (amount > 0 ? "I" : "E");

  const stagedImportId = randomUUID();
  const expiresAt = new Date(Date.now() + STAGE_TTL_MS);
  const dupCount = shaped.filter((r) => r.dedupStatus !== "new").length;

  const buildStagedRow = (r: Shaped, stagedImportIdLocal: string) => ({
    id: randomUUID(),
    stagedImportId: stagedImportIdLocal,
    userId,
    date: r.date,
    currency: r.currency ?? knobs.defaultCurrency ?? boundAccountCurrency ?? "CAD",
    amount: r.amount,
    // User-tier encryption: DEK available, wrap directly under the user's DEK.
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
    // FINLYNQ-195 — investment-import capture (encrypted-in-place like payee).
    ticker: encryptField(dek, r.ticker ?? null),
    securityName: encryptField(dek, r.portfolioHolding ?? null),
    portfolioHoldingId: null,
    enteredAmount: r.enteredAmount ?? null,
    enteredCurrency: r.enteredCurrency ?? knobs.defaultCurrency ?? null,
    tags: r.tags ?? null,
    fitId: r.fitId ?? null,
    peerStagedId: null,
    targetAccountId: null,
    dedupStatus: r.dedupStatus,
    rowStatus: "pending",
    reconcileState:
      alreadyImportedHashes.has(r.hash) || fuzzySkip.has(r.rowIndex)
        ? "skipped_duplicate"
        : "unmatched",
  });

  await db.transaction(async (tx) => {
    await tx.insert(schema.stagedImports).values({
      id: stagedImportId,
      userId,
      source: ctx.source ?? "upload",
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
      fileFormat: ctx.fileFormatOverride ?? parseResult.format,
      // FINLYNQ-120 — filename lands at USER tier (v1:) with a session DEK.
      originalFilename: encryptStagingMeta(ctx.fileName, "user", dek),
      encryptionTier: "user",
      skipHeaderRows: knobs.skipHeaderRows,
      skipFooterRows: knobs.skipFooterRows,
      dateFormatOverride: knobs.dateFormatOverride,
      defaultCurrency: knobs.defaultCurrency,
      dateRangeStart,
      dateRangeEnd,
      parsedAnchors:
        parseResult.anchors.length > 0 ? parseResult.anchors : null,
    });

    if (shaped.length > 0) {
      const chunk = 500;
      for (let i = 0; i < shaped.length; i += chunk) {
        const slice = shaped.slice(i, i + chunk);
        await tx
          .insert(schema.stagedTransactions)
          .values(slice.map((r) => buildStagedRow(r, stagedImportId)));
      }
    }
  });

  const newCount = shaped.filter((r) => r.dedupStatus === "new").length;
  return {
    ok: true,
    stagedImportId,
    format: parseResult.format,
    rowCount: shaped.length,
    duplicateCount: dupCount,
    newCount,
    dateStart: statementPeriodStart,
    dateEnd: statementPeriodEnd,
    statementBalance,
    statementBalanceDate,
    statementCurrency,
    counts: {
      new: newCount,
      existing: shaped.filter((r) => r.dedupStatus === "existing").length,
      probableDuplicate: shaped.filter(
        (r) => r.dedupStatus === "probable_duplicate",
      ).length,
      skippedDuplicate: shaped.filter((r) => alreadyImportedHashes.has(r.hash))
        .length,
      errors: rowErrors.length + parseResult.errors.length,
    },
    rowErrors,
  };
}

/**
 * A parse failure carries the ParseFailure body + a `detectedFormat` hint so
 * the MCP tool can report `detectedFormat:'unrecognised'` for an unsupported
 * extension, and the web route can map `status`/`body` back to a NextResponse.
 */
export type StageStatementResult =
  | StageStatementSuccess
  | {
      ok: false;
      /** HTTP-style status (400/404/422) for the web route. */
      status: number;
      /** Error body for the web route. */
      body: Record<string, unknown>;
      /** 'unrecognised' for an unsupported extension/parse miss, else the format. */
      detectedFormat: StatementFileFormat | "unrecognised";
    };

export interface StageStatementInput {
  userId: string;
  /** User DEK — required to encrypt staged rows under the user key. */
  dek: Buffer;
  /** The statement file (CSV / OFX / QFX). Caller constructs from raw bytes. */
  file: File;
  /**
   * Finlynq account id to bind the import to. Required for OFX/QFX (single-
   * account statements). CSV may omit it (rows resolve via an Account column).
   */
  accountId: number | null;
  /** Optional saved CSV column-mapping template. */
  templateId?: number | null;
  /** Optional user-typed statement balance (CSV — no parseable LEDGERBAL). */
  userStatementBalance?: number | null;
  /** Optional parser knobs (defaults match pre-FINLYNQ-54 behavior). */
  knobs?: Partial<ParseStatementKnobs>;
  /** Optional OFX/QFX payee source override (default 'name'). */
  payeeSource?: "name" | "memo";
}

/**
 * Parse → classify → dedup → write `staged_imports` + `staged_transactions`.
 * The autonomous detailed-staging path: no confirm-mapping gates, no simplified
 * bank-ledger-direct path. Returns the staging summary the MCP `upload_statement`
 * tool surfaces verbatim.
 */
export async function stageStatementFile(
  input: StageStatementInput,
): Promise<StageStatementResult> {
  const { userId, dek, file, accountId } = input;
  const templateId = input.templateId ?? null;
  const knobs: ParseStatementKnobs = {
    skipHeaderRows: input.knobs?.skipHeaderRows ?? 0,
    skipFooterRows: input.knobs?.skipFooterRows ?? 0,
    dateFormatOverride: input.knobs?.dateFormatOverride ?? null,
    defaultCurrency: input.knobs?.defaultCurrency ?? null,
  };
  const payeeSource = input.payeeSource ?? "name";

  const ext = file.name.split(".").pop()?.toLowerCase();

  // ─── Resolve + verify the bound account ──────────────────────────────────
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
        and(eq(schema.accounts.userId, userId), eq(schema.accounts.id, accountId)),
      )
      .get();
    if (!acct) {
      return {
        ok: false,
        status: 404,
        body: { error: `Account #${accountId} not found` },
        // Account-not-found is an ownership error, not a format failure — keep
        // the real format when the extension is recognised.
        detectedFormat:
          ext === "csv" || ext === "ofx" || ext === "qfx" ? ext : "unrecognised",
      };
    }
    defaultAccountName = decryptName(acct.nameCt, dek, null) ?? "";
    boundAccountCurrency = acct.currency;
  }

  // ─── Parse ───────────────────────────────────────────────────────────────
  const parseResult = await parseStatement(
    file,
    ext,
    templateId,
    userId,
    defaultAccountName,
    knobs,
    boundAccountCurrency,
    { payeeSource, confirmAutoMapping: false, fileName: file.name },
  );
  if ("status" in parseResult) {
    // ParseFailure — an unsupported extension or any hard parse miss reads as
    // 'unrecognised'; the route maps status/body to a response.
    const detectedFormat: StatementFileFormat | "unrecognised" =
      ext === "csv" || ext === "ofx" || ext === "qfx" ? ext : "unrecognised";
    return {
      ok: false,
      status: parseResult.status,
      body: parseResult.body,
      detectedFormat,
    };
  }
  if (parseResult.rows.length === 0) {
    return {
      ok: false,
      status: 400,
      body: { error: "No transactions found in file" },
      detectedFormat: parseResult.format,
    };
  }
  if (parseResult.rows.length > MAX_STAGING_ROWS) {
    return {
      ok: false,
      status: 422,
      body: {
        error: `Statement contains ${parseResult.rows.length.toLocaleString()} rows, exceeding the ${MAX_STAGING_ROWS.toLocaleString()} staging limit. Split the file.`,
      },
      detectedFormat: parseResult.format,
    };
  }

  // FINLYNQ-159 / FINLYNQ-195 — reject non-finite / absurd-magnitude numeric
  // fields before any row lands in staging. The staging path bypasses
  // previewImport's per-row check, so enforce the finite/sane bound here.
  const amountErr = findUnreasonableAmountError(parseResult.rows);
  if (amountErr) {
    return {
      ok: false,
      status: 400,
      body: { error: amountErr },
      detectedFormat: parseResult.format,
    };
  }

  // ─── Classify + dedup + write (shared chokepoint) ────────────────────────
  return writeStagedImport(parseResult, {
    userId,
    dek,
    accountId,
    fileName: file.name,
    knobs,
    boundAccountCurrency,
    userStatementBalance: input.userStatementBalance ?? null,
  });
}
