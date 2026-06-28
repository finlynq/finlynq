import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireEncryption } from "@/lib/auth/require-encryption";
import {
  summarizeGenericCsv,
  type GenericCsvSummary,
} from "@/lib/external-import/generic-csv-orchestrator";
import { genericCsv } from "@finlynq/import-connectors";
import {
  GENERIC_REQUIRED_FIELDS,
  type GenericCsvMapping,
} from "@finlynq/import-connectors/generic-csv";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

const mappingSchema = z
  .object({
    date: z.string().optional(),
    amount: z.string().optional(),
    account: z.string().optional(),
    currency: z.string().optional(),
    note: z.string().optional(),
    category: z.string().optional(),
    accountTo: z.string().optional(),
    amountTo: z.string().optional(),
    currencyTo: z.string().optional(),
  })
  .partial();

/**
 * POST /api/import/connectors/generic-csv/preview
 * Multipart form: `file` (the CSV), optional `mapping` (JSON logical-field →
 * header), optional `defaultCurrency`, optional `includeOpeningBalance` ("0").
 *
 * Read-only. Always returns the headers, a few sample rows, and a column
 * mapping (the caller's, sanitized, or an alias-derived best guess) so the user
 * can confirm/fix the mapping. When the mapping resolves all required fields it
 * also returns the account/category/transfer summary. No DB writes.
 */
export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;

  const form = await request.formData();
  const file = form.get("file");
  const mappingJson = form.get("mapping");
  const defaultCurrencyRaw = form.get("defaultCurrency");
  const includeOpeningRaw = form.get("includeOpeningBalance");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing 'file' form field" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "CSV exceeds 10 MB" }, { status: 413 });
  }

  const text = await file.text();
  const headers = genericCsv.genericCsvHeaders(text);
  if (headers.length === 0) {
    return NextResponse.json({ error: "The file has no header row." }, { status: 400 });
  }
  const sampleRows = genericCsv.sampleGenericCsvRows(text, 5);
  const headerSet = new Set(headers);

  // Resolve the working mapping: caller's (sanitized to real headers) or a
  // best-guess from header aliases.
  let working: Partial<GenericCsvMapping>;
  if (typeof mappingJson === "string" && mappingJson.trim()) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(mappingJson);
    } catch {
      return NextResponse.json({ error: "Invalid mapping JSON" }, { status: 400 });
    }
    const parsed = mappingSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid mapping" }, { status: 400 });
    }
    working = {};
    for (const [field, header] of Object.entries(parsed.data)) {
      if (typeof header === "string" && headerSet.has(header)) {
        (working as Record<string, string>)[field] = header;
      }
    }
  } else {
    working = genericCsv.suggestGenericCsvMapping(headers).mapping;
  }

  const missingRequired = GENERIC_REQUIRED_FIELDS.filter((f) => !working[f]);
  const mappingComplete = missingRequired.length === 0;

  const defaultCurrency =
    typeof defaultCurrencyRaw === "string" && defaultCurrencyRaw.trim()
      ? defaultCurrencyRaw.trim().toUpperCase()
      : undefined;
  const includeOpeningBalance = includeOpeningRaw === "0" ? false : true;

  let summary: GenericCsvSummary | null = null;
  if (mappingComplete) {
    try {
      summary = await summarizeGenericCsv(
        text,
        working as GenericCsvMapping,
        auth.userId,
        auth.dek,
        { defaultCurrency, includeOpeningBalance },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Preview failed";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  return NextResponse.json({
    headers,
    sampleRows,
    mapping: working,
    missingRequired,
    mappingComplete,
    summary,
  });
}
