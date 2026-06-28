import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireEncryption } from "@/lib/auth/require-encryption";
import {
  executeGenericCsvImport,
  type GenericCsvAccountChoice,
} from "@/lib/external-import/generic-csv-orchestrator";
import { genericCsv } from "@finlynq/import-connectors";
import {
  GENERIC_REQUIRED_FIELDS,
  type GenericCsvMapping,
} from "@finlynq/import-connectors/generic-csv";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

const mappingSchema = z.object({
  date: z.string().min(1),
  amount: z.string().min(1),
  account: z.string().min(1),
  currency: z.string().optional(),
  note: z.string().optional(),
  category: z.string().optional(),
  accountTo: z.string().optional(),
  amountTo: z.string().optional(),
  currencyTo: z.string().optional(),
});

const choiceSchema = z.union([
  z.object({ mode: z.literal("existing"), accountId: z.number().int() }),
  z.object({
    mode: z.literal("create"),
    currency: z.string().min(1).max(10),
    type: z.enum(["A", "L"]),
  }),
]);
const choicesSchema = z.record(z.string(), choiceSchema);

/**
 * POST /api/import/connectors/generic-csv/execute
 * Multipart form: `file` (the CSV), `mapping` (JSON logical-field → header,
 * required fields date/amount/account), `choices` (JSON source account name →
 * use-existing / create-new), optional `defaultCurrency`,
 * `includeOpeningBalance` ("0"). Resolve-or-creates accounts + categories then
 * commits via the import pipeline (txSource 'connector'). Transfer legs become
 * link_id-paired rows; cross-currency (FX) transfers that supply an explicit
 * amount_received + currency_to are imported faithfully (each leg in its own
 * currency), while ambiguous same-currency-row transfers into different-currency
 * accounts are refused.
 */
export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;

  const form = await request.formData();
  const file = form.get("file");
  const mappingJson = form.get("mapping");
  const choicesJson = form.get("choices");
  const defaultCurrencyRaw = form.get("defaultCurrency");
  const includeOpeningRaw = form.get("includeOpeningBalance");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing 'file' form field" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "CSV exceeds 10 MB" }, { status: 413 });
  }

  if (typeof mappingJson !== "string" || !mappingJson.trim()) {
    return NextResponse.json({ error: "Missing 'mapping' form field" }, { status: 400 });
  }
  let mappingRaw: unknown;
  try {
    mappingRaw = JSON.parse(mappingJson);
  } catch {
    return NextResponse.json({ error: "Invalid mapping JSON" }, { status: 400 });
  }
  const mappingParsed = mappingSchema.safeParse(mappingRaw);
  if (!mappingParsed.success) {
    return NextResponse.json(
      { error: "Invalid mapping — date, amount, and account are required." },
      { status: 400 },
    );
  }
  const mapping = mappingParsed.data as GenericCsvMapping;

  let choices: Record<string, GenericCsvAccountChoice> = {};
  if (typeof choicesJson === "string" && choicesJson.trim()) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(choicesJson);
    } catch {
      return NextResponse.json({ error: "Invalid choices JSON" }, { status: 400 });
    }
    const parsed = choicesSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid account choices", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    choices = parsed.data as Record<string, GenericCsvAccountChoice>;
  }

  const text = await file.text();
  const headers = new Set(genericCsv.genericCsvHeaders(text));
  const missing = GENERIC_REQUIRED_FIELDS.filter(
    (f) => !headers.has(mapping[f] as string),
  );
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Mapping references columns not in the file: ${missing.join(", ")}` },
      { status: 400 },
    );
  }

  const defaultCurrency =
    typeof defaultCurrencyRaw === "string" && defaultCurrencyRaw.trim()
      ? defaultCurrencyRaw.trim().toUpperCase()
      : undefined;
  const includeOpeningBalance = includeOpeningRaw === "0" ? false : true;

  try {
    const result = await executeGenericCsvImport(
      text,
      mapping,
      auth.userId,
      auth.dek,
      choices,
      { defaultCurrency, includeOpeningBalance },
    );
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Import failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
