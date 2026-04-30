import { NextRequest, NextResponse } from "next/server";
import {
  csvToRawTransactions,
  csvToRawTransactionsWithMapping,
} from "@/lib/csv-parser";
import { parseOfx } from "@/lib/ofx-parser";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { classifyForReconcile, MAX_RECONCILE_ROWS } from "@/lib/reconcile";
import { safeErrorMessage } from "@/lib/validate";
import type { RawTransaction } from "@/lib/import-pipeline";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import {
  deserializeTemplate,
  type ColumnMapping,
} from "@/lib/import-templates";

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
      const acct = await db
        .select({ id: schema.accounts.id, name: schema.accounts.name })
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
      defaultAccountName = acct.name ?? "";
    }

    const ext = file.name.split(".").pop()?.toLowerCase();
    const parseResult = await parseStatement(
      file,
      ext,
      templateId,
      userId,
      defaultAccountName,
    );
    if ("error" in parseResult) {
      return NextResponse.json({ error: parseResult.error }, { status: 400 });
    }
    if (parseResult.rows.length === 0) {
      return NextResponse.json(
        { error: "No transactions found in file" },
        { status: 400 },
      );
    }
    if (parseResult.rows.length > MAX_RECONCILE_ROWS) {
      return NextResponse.json(
        {
          error: `Statement contains ${parseResult.rows.length.toLocaleString()} rows, exceeding the ${MAX_RECONCILE_ROWS.toLocaleString()} reconcile limit. Split the file.`,
        },
        { status: 422 },
      );
    }

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
}

async function parseStatement(
  file: File,
  ext: string | undefined,
  templateId: number | null,
  userId: string,
  defaultAccountName: string | null,
): Promise<ParseSuccess | { error: string }> {
  if (ext === "csv") {
    const text = await file.text();
    let parsed: { rows: RawTransaction[]; errors: Array<{ row: number; message: string }> };
    if (templateId !== null && !Number.isNaN(templateId)) {
      const tplRow = await db
        .select()
        .from(schema.importTemplates)
        .where(
          and(
            eq(schema.importTemplates.id, templateId),
            eq(schema.importTemplates.userId, userId),
          ),
        )
        .get();
      if (!tplRow) {
        return { error: `Template #${templateId} not found` };
      }
      const tpl = deserializeTemplate(tplRow);
      parsed = csvToRawTransactionsWithMapping(
        text,
        tpl.columnMapping as unknown as Record<string, string>,
      );
      if (tpl.defaultAccount) {
        parsed.rows = parsed.rows.map((r) => ({
          ...r,
          account: r.account || tpl.defaultAccount!,
        }));
      }
    } else {
      parsed = csvToRawTransactions(text);
    }
    if (defaultAccountName) {
      parsed.rows = parsed.rows.map((r) => ({
        ...r,
        account: r.account || defaultAccountName,
      }));
    }
    return { ...parsed, format: "csv" };
  }

  if (ext === "ofx" || ext === "qfx") {
    const text = await file.text();
    const ofx = parseOfx(text);
    if (ofx.transactions.length === 0) {
      return { error: "No transactions found in OFX/QFX file" };
    }
    if (!defaultAccountName) {
      return {
        error:
          "OFX/QFX statements need an explicit accountId — pick the destination Finlynq account before uploading.",
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
    return { rows, errors: [], format: "ofx" };
  }

  return {
    error: `Unsupported file type "${ext ?? "unknown"}". Reconcile mode supports CSV, OFX, and QFX. For PDF/Excel, use the regular import flow first.`,
  };
}
