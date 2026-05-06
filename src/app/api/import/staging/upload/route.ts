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
 *   { stagedImportId: string, redirectTo: string, counts: {...} }
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
 * `transactions.source` is stamped at approve time in the existing
 * `/api/import/staged/[id]/approve` endpoint. This route writes the
 * `staged_imports.source = 'upload'` and `staged_imports.file_format`
 * fields so the approve endpoint can choose the correct `source:<format>`
 * tag for `transactions.tags`.
 */

import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, eq, inArray, or } from "drizzle-orm";
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
    const existingFitIds = await checkFitIdDuplicates(fitIds);
    const existingHashes = await checkDuplicates(hashes);

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

    // ─── INSERT ─────────────────────────────────────────────────────────
    // staged_imports row + staged_transactions rows in a single transaction
    // so a partial INSERT failure rolls back the whole upload.
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
      });

      if (shaped.length > 0) {
        const chunk = 500;
        for (let i = 0; i < shaped.length; i += chunk) {
          const slice = shaped.slice(i, i + chunk);
          await tx.insert(schema.stagedTransactions).values(
            slice.map((r) => ({
              id: randomUUID(),
              stagedImportId,
              userId,
              date: r.date,
              amount: r.amount,
              currency: r.currency ?? boundAccountCurrency ?? "CAD",
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
              enteredCurrency: r.enteredCurrency ?? null,
              tags: r.tags ?? null,
              fitId: r.fitId ?? null,
              peerStagedId: null,
              targetAccountId: null,
              dedupStatus: r.dedupStatus,
              rowStatus: "pending",
            })),
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
): Promise<ParseSuccess | ParseFailure> {
  if (ext === "csv") {
    const text = await file.text();
    const result = await parseCsvWithFallback({
      text,
      userId,
      templateId,
      defaultAccountName,
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
