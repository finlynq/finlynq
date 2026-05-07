/**
 * Shared CSV parser pipeline (issue #63).
 *
 * Both `/api/import/preview` and `/api/import/staging/upload` need the
 * same fallback chain to handle non-canonical bank export headers
 * (`Transaction Date` / `Description` / `Debit` / `Credit` etc.). Before
 * this module they each had their own implementation; the staging-upload
 * path replaced the old `/api/import/reconcile/preview` route in #153.
 *
 * Behavior is sourced from one place. See [route.ts](../../../app/api/import/preview/route.ts)
 * and [staging/upload/route.ts](../../../app/api/import/staging/upload/route.ts).
 *
 * The pipeline is **read-only** — no DB writes, no encryption. Encryption
 * stays at the commit boundary in the route handlers / `reconcile.ts`. The
 * pipeline does read the user's saved import templates to look up an
 * explicit `templateId` and to auto-match on header signature.
 */

import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import {
  csvToRawTransactions,
  csvToRawTransactionsWithMapping,
  extractCsvHeaders,
  parseCSV,
} from "@/lib/csv-parser";
import {
  autoDetectColumnMapping,
  deserializeTemplate,
  findBestTemplate,
  type ColumnMapping,
  type ImportTemplate,
} from "@/lib/import-templates";
import type { RawTransaction } from "@/lib/import-pipeline";

export type ParseError = { row: number; message: string };

export interface CsvPipelineRequest {
  /** Raw CSV text (caller is responsible for `await file.text()`). */
  text: string;
  /** Owner of the saved templates table; required for steps 1 + 3. */
  userId: string;
  /** Explicit template selected by the caller — short-circuits step 1. */
  templateId?: number | null;
  /**
   * Default account name to fill in on rows whose source format doesn't
   * carry one (e.g. OFX single-account, CSV without an `Account` column,
   * reconcile callers that pass an explicit `accountId`).
   */
  defaultAccountName?: string | null;
}

export type CsvPipelineResult =
  | {
      kind: "parsed";
      rows: RawTransaction[];
      errors: ParseError[];
      headers: string[];
      /** Set when steps 1 or 3 matched. */
      appliedTemplateId?: number;
      /** Set when step 3 (auto-match) succeeded — for UI hints. */
      suggestedTemplate?: { id: number; name: string; score: number };
    }
  | {
      kind: "needs-mapping";
      headers: string[];
      sampleRows: Record<string, string>[];
      suggestedMapping: ColumnMapping | null;
    }
  | {
      kind: "template-not-found";
      templateId: number;
    };

/**
 * Run the full four-step CSV parser fallback chain.
 *
 * 1. Explicit `templateId` -> use its column mapping.
 * 2. Canonical headers (`Date` / `Amount` / `Account` / `Payee`).
 * 3. Auto-matched saved template (≥80% header overlap).
 * 4. Otherwise -> `needs-mapping` with autoDetectColumnMapping suggestion.
 *
 * Step 2 and step 3 only "succeed" if at least one row parsed cleanly.
 * If the canonical-header pass produces zero valid rows AND no saved
 * template matches, the caller gets `needs-mapping` so the UI can prompt
 * the user for a column-mapping dialog.
 */
export async function parseCsvWithFallback(
  req: CsvPipelineRequest,
): Promise<CsvPipelineResult> {
  const { text, userId, templateId, defaultAccountName } = req;
  const headers = extractCsvHeaders(text);

  // 1. Explicit template selected by user — use its mapping directly.
  if (templateId !== null && templateId !== undefined && !Number.isNaN(templateId)) {
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
      return { kind: "template-not-found", templateId };
    }
    const tpl = deserializeTemplate(tplRow);
    const mapped = parseWithMapping(text, tpl.columnMapping, tpl.defaultAccount ?? null);
    const filled = applyDefaultAccount(mapped.rows, defaultAccountName);
    return {
      kind: "parsed",
      rows: filled,
      errors: mapped.errors,
      headers,
      appliedTemplateId: tpl.id,
    };
  }

  // 2. Try canonical headers (Date / Amount / Account / Payee).
  const canonical = csvToRawTransactions(text);
  if (canonical.rows.length > 0) {
    const filled = applyDefaultAccount(canonical.rows, defaultAccountName);
    return {
      kind: "parsed",
      rows: filled,
      errors: canonical.errors,
      headers,
    };
  }

  // 3. Try an auto-matched saved template (≥80% header overlap).
  const allTemplates = await db
    .select()
    .from(schema.importTemplates)
    .where(eq(schema.importTemplates.userId, userId))
    .all();
  const templates: ImportTemplate[] = allTemplates.map(deserializeTemplate);
  const best = findBestTemplate(headers, templates);
  if (best) {
    const mapped = parseWithMapping(
      text,
      best.template.columnMapping,
      best.template.defaultAccount ?? null,
    );
    if (mapped.rows.length > 0) {
      const filled = applyDefaultAccount(mapped.rows, defaultAccountName);
      return {
        kind: "parsed",
        rows: filled,
        errors: mapped.errors,
        headers,
        appliedTemplateId: best.template.id,
        suggestedTemplate: {
          id: best.template.id,
          name: best.template.name,
          score: best.score,
        },
      };
    }
  }

  // 4. Nothing worked — return headers + auto-detected suggestion so the
  //    client can show a column-mapping dialog.
  const suggestedMapping = autoDetectColumnMapping(headers);
  const sampleRows = parseCSV(text).slice(0, 5);
  return {
    kind: "needs-mapping",
    headers,
    sampleRows,
    suggestedMapping,
  };
}

/** Parse a CSV with a column mapping and apply a template-level default account. */
function parseWithMapping(
  text: string,
  mapping: ColumnMapping,
  defaultAccount: string | null,
): { rows: RawTransaction[]; errors: ParseError[] } {
  const result = csvToRawTransactionsWithMapping(
    text,
    mapping as unknown as Record<string, string>,
  );
  if (defaultAccount) {
    result.rows = result.rows.map((r) => ({
      ...r,
      account: r.account || defaultAccount,
    }));
  }
  return result;
}

/**
 * Fill in `account` on rows whose source format didn't carry one. Caller-
 * supplied `defaultAccountName` (typically derived from an explicit
 * accountId) takes precedence over template-level defaults already applied.
 */
function applyDefaultAccount(
  rows: RawTransaction[],
  defaultAccountName: string | null | undefined,
): RawTransaction[] {
  if (!defaultAccountName) return rows;
  return rows.map((r) => ({
    ...r,
    account: r.account || defaultAccountName,
  }));
}

/**
 * Build a richer "0 rows parsed" error message for the caller to surface.
 * Includes byte count and the first non-empty line so users can see what
 * we actually received. Common-case hint covers semicolon/tab separators
 * (the parser is comma-only; users on European bank exports hit this).
 */
export function buildEmptyCsvError(text: string): string {
  const cleaned = text.replace(/^\uFEFF/, "");
  const bytes = Buffer.byteLength(text, "utf8");
  const firstLine =
    cleaned
      .split(/\r\n|\r|\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const truncated = firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
  const hint =
    "If the file uses semicolons or tabs as separators, please re-export as comma-separated.";
  if (!truncated) {
    return `No transactions found in file (csv, ${bytes} bytes — file appears empty). ${hint}`;
  }
  return `No transactions found in file (csv, ${bytes} bytes). First line: ${JSON.stringify(truncated)}. ${hint}`;
}
