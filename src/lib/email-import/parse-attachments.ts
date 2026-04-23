/**
 * Resend Inbound attachment → RawTransaction[] parser.
 *
 * Resend posts attachments as base64-encoded bytes alongside a filename and
 * content type. We decode, dispatch to the existing CSV/OFX/PDF/Excel parsers
 * in src/lib/*, and return flat rows for staging.
 *
 * Bank templates are applied per-user — we try to match the CSV header row
 * against the user's saved `import_templates` before falling back to
 * auto-detect. (Same logic as the old auto-import multipart handler.)
 */

import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import {
  csvToRawTransactions,
  csvToRawTransactionsWithMapping,
  extractCSVHeaders,
} from "@/lib/csv-parser";
import { extractExcelRows, parseExcelSheets } from "@/lib/excel-parser";
import type { RawTransaction } from "@/lib/import-pipeline";
import { deserializeTemplate, findBestTemplate, autoDetectColumnMapping } from "@/lib/import-templates";

export interface ResendAttachment {
  filename: string;
  /** Resend may send either `content_type` or `contentType` — we accept both. */
  contentType?: string;
  /** base64-encoded bytes. Resend docs currently say `content_b64`; accept `content` too. */
  content: string;
}

/**
 * Parse Resend attachments into flat RawTransaction rows for the given user.
 * Unrecognized file types are skipped silently.
 */
export async function parseResendAttachments(
  attachments: ResendAttachment[],
  userId: string,
): Promise<RawTransaction[]> {
  // Load the user's templates once for CSV header matching.
  const templateRows = await db
    .select()
    .from(schema.importTemplates)
    .where(eq(schema.importTemplates.userId, userId))
    .all();
  const templates = templateRows.map(deserializeTemplate);

  const allRows: RawTransaction[] = [];

  for (const att of attachments) {
    const ext = att.filename.split(".").pop()?.toLowerCase();
    const buffer = Buffer.from(att.content, "base64");
    let rows: RawTransaction[] = [];

    if (ext === "csv" || att.contentType === "text/csv") {
      const text = buffer.toString("utf8");
      const headers = extractCSVHeaders(text);
      const bestMatch = findBestTemplate(headers, templates);

      if (bestMatch) {
        const result = csvToRawTransactionsWithMapping(
          text,
          bestMatch.template.columnMapping as unknown as Record<string, string>,
        );
        rows = result.rows;
        if (bestMatch.template.defaultAccount) {
          rows = rows.map((r) => ({
            ...r,
            account: r.account || bestMatch.template.defaultAccount!,
          }));
        }
      } else {
        rows = csvToRawTransactions(text).rows;
      }
    } else if (ext === "pdf" || att.contentType === "application/pdf") {
      // Dynamic import — PDF parser is heavy (~5 MB), lazy-load.
      const { parsePdfToTransactions } = await import("@/lib/pdf-parser");
      const result = await parsePdfToTransactions(buffer);
      rows = result.rows;
    } else if (ext === "xlsx" || ext === "xls") {
      const sheets = parseExcelSheets(buffer);
      if (sheets.length > 0 && sheets[0].headers.length > 0) {
        const sheet = sheets[0];
        const mapping = autoDetectColumnMapping(sheet.headers);
        if (mapping) {
          rows = extractExcelRows(buffer, sheet.name, mapping).rows;
        }
      }
    }
    // OFX/QFX from email — add later if needed (banks rarely send OFX).

    allRows.push(...rows);
  }

  return allRows;
}
