import { NextRequest, NextResponse } from "next/server";
import { parseOfx } from "@/lib/ofx-parser";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { classifyForReconcile, MAX_RECONCILE_ROWS } from "@/lib/reconcile";
import { safeErrorMessage } from "@/lib/validate";
import type { RawTransaction } from "@/lib/import-pipeline";
import { sourceTagFor, type FormatTag } from "@/lib/tx-source";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import {
  buildEmptyCsvError,
  parseCsvWithFallback,
} from "@/lib/external-import/parsers/csv-pipeline";
import { parseOfxToCanonical } from "@/lib/external-import/parsers/ofx";
import { parseQfxToCanonical } from "@/lib/external-import/parsers/qfx";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * Reconcile-mode preview (issue #36). Single endpoint that accepts a
 * statement file (CSV / OFX / QFX), parses it, and runs the three-way
 * classifier (NEW / EXISTING / PROBABLE_DUPLICATE) before any write.
 *
 * Multipart body:
 *   file        — the statement
 *   accountId   — optional default Finlynq account id (used when the
 *                 source format doesn't carry an account name, e.g. OFX
 *                 single-account exports). Validated server-side.
 *   templateId  — optional saved CSV column mapping
 *   tolerance   — optional probable-duplicate fuzz window (days, default 3)
 */
export async function POST(request: NextRequest) {
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
        : undefined;
    if (tolerance !== undefined && (Number.isNaN(tolerance) || tolerance < 0 || tolerance > 30)) {
      return NextResponse.json(
        { error: "tolerance must be between 0 and 30 days" },
        { status: 400 },
      );
    }

    // Resolve the default account name once if the caller passed an
    // accountId — used to fill row.account on rows whose source format
    // doesn't carry one (OFX single-account, CSV without an Account column).
    let defaultAccountName: string | null = null;
    if (accountId !== null) {
      // Stream D Phase 4 — plaintext name dropped; decrypt name_ct.
      const { decryptName } = await import("@/lib/crypto/encrypted-columns");
      const acct = await db
        .select({ id: schema.accounts.id, nameCt: schema.accounts.nameCt })
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
      defaultAccountName = decryptName(acct.nameCt, auth.dek, null) ?? "";
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
      // Use the richer "0 rows" message for CSVs (format / bytes / first
      // line / separator hint) so the user can see what we actually read.
      // OFX/QFX zero-row branches already returned their own error above.
      const csvText = parseResult.format === "csv" ? parseResult.csvText ?? "" : "";
      const message =
        parseResult.format === "csv"
          ? buildEmptyCsvError(csvText)
          : "No transactions found in file";
      return NextResponse.json({ error: message }, { status: 400 });
    }
    if (parseResult.rows.length > MAX_RECONCILE_ROWS) {
      return NextResponse.json(
        {
          error: `Statement contains ${parseResult.rows.length.toLocaleString()} rows, exceeding the ${MAX_RECONCILE_ROWS.toLocaleString()} reconcile limit. Split the file.`,
        },
        { status: 422 },
      );
    }

    // Issue #62: stamp source:<format> on every row before classification.
    // Use the file extension as the format hint (ofx vs qfx are distinct
    // formats — qfx adds Quicken's <INTU.BID> block on top of OFX XML).
    const formatTag: FormatTag =
      ext === "qfx" ? "qfx" : ext === "ofx" ? "ofx" : "csv";
    const sourceTagStr = sourceTagFor(formatTag);
    parseResult.rows = parseResult.rows.map((r) => {
      const existing = (r.tags ?? "").split(",").map((t) => t.trim()).filter((t) => t);
      if (existing.some((t) => t.toLowerCase() === sourceTagStr.toLowerCase())) return r;
      return { ...r, tags: existing.length ? `${existing.join(",")},${sourceTagStr}` : sourceTagStr };
    });

    const classified = await classifyForReconcile(userId, dek, parseResult.rows, {
      dateToleranceDays: tolerance,
    });

    return NextResponse.json({
      format: parseResult.format,
      rows: classified.rows,
      errors: [
        ...classified.errors,
        ...parseResult.errors.map((e) => ({
          rowIndex: e.row - 2,
          message: e.message,
        })),
      ],
      counts: classified.counts,
      tolerance: tolerance ?? 3,
      defaultAccountName,
    });
  } catch (error) {
    const message = safeErrorMessage(error, "Reconcile preview failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

interface ParseSuccess {
  rows: RawTransaction[];
  errors: Array<{ row: number; message: string }>;
  format: "csv" | "ofx";
  /** Verbatim CSV text — kept around so the route can build a richer 0-row error. */
  csvText?: string;
}

interface ParseFailure {
  status: number;
  body: Record<string, unknown>;
}

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
      // Surface the column-mapping payload so a future reconcile UI can
      // show the same dialog the regular /import flow uses. Until that
      // dialog is wired in, the human-readable `error` keeps the existing
      // UI useful — it tells the user we couldn't auto-detect columns.
      return {
        status: 422,
        body: {
          type: "csv-needs-mapping",
          error:
            "We couldn't auto-detect the columns in this CSV. The reconcile flow doesn't yet support a column-mapping dialog — import the file via /import first to save a template, then re-upload here.",
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
      csvText: text,
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
    // Investment-statement dispatch (issue #126). Mirrors the same
    // detect-and-route the regular /api/import/preview route uses around
    // line 84. The legacy `parseOfx()` path returns zero rows for an
    // <INVSTMTRS> file, so we need to detect investment files BEFORE the
    // legacy parser and route them through the canonical investment
    // emitter (which handles BUYSTOCK / SELLSTOCK / INCOME / TRANSFER /
    // INVBANKTRAN constructs).
    //
    // The reconcile flow is single-account: the user picks one Finlynq
    // account at upload time. The canonical emitter sets `account` to a
    // synthetic external id (`ofx:invacct:broker:acct`) per brokerage
    // statement found in the file, so we rewrite every emitted row's
    // `account` to the user-bound `defaultAccountName` — same as the
    // legacy bank/CC branch does. The classifier resolves accounts by
    // lowercase-name lookup (`buildAccountLookup` in src/lib/reconcile.ts),
    // so the rewrite is sufficient. Per-row `portfolioHolding` (e.g.
    // "Cash" or the security name) is preserved on the row; the UI is
    // expected to bind it to a `portfolioHoldingId` before commit, which
    // `commitReconcile()` enforces for investment accounts.
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
      return { rows, errors: [], format: "ofx" };
    }

    // Legacy bank/CC path — unchanged behavior. parseOfx() handles SGML
    // and XML forms of OFX/QFX with bank or credit-card statements.
    const ofx = parseOfx(text);
    if (ofx.transactions.length === 0) {
      return { status: 400, body: { error: "No transactions found in OFX/QFX file" } };
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
    return { rows, errors: [], format: "ofx" };
  }

  return {
    status: 400,
    body: {
      error: `Unsupported file type "${ext ?? "unknown"}". Reconcile mode supports CSV, OFX, and QFX. For PDF/Excel, use the regular import flow first.`,
    },
  };
}
