import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireEncryption } from "@/lib/auth/require-encryption";
import {
  executeMoneyProImport,
  type MoneyProAccountChoice,
} from "@/lib/external-import/moneypro-orchestrator";
import { moneypro } from "@finlynq/import-connectors";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

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
 * POST /api/import/connectors/moneypro/execute
 * Multipart form: `file` (the Money Pro CSV), `choices` (JSON mapping each
 * source account name → use-existing / create-new), optional `defaultCurrency`.
 * Resolve-or-creates accounts + categories, then commits via the import
 * pipeline (txSource 'connector'). Transfer legs become link_id-paired rows.
 */
export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;

  const form = await request.formData();
  const file = form.get("file");
  const choicesJson = form.get("choices");
  const defaultCurrencyRaw = form.get("defaultCurrency");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing 'file' form field" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "CSV exceeds 10 MB" }, { status: 413 });
  }

  let choices: Record<string, MoneyProAccountChoice> = {};
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
    choices = parsed.data as Record<string, MoneyProAccountChoice>;
  }

  const text = await file.text();
  const headers = moneypro.moneyProHeaders(text);
  if (!moneypro.isMoneyProCsv(headers)) {
    return NextResponse.json(
      { error: "This doesn't look like a Money Pro export.", headers },
      { status: 400 },
    );
  }

  const defaultCurrency =
    typeof defaultCurrencyRaw === "string" && defaultCurrencyRaw.trim()
      ? defaultCurrencyRaw.trim().toUpperCase()
      : undefined;

  try {
    const result = await executeMoneyProImport(
      text,
      auth.userId,
      auth.dek,
      choices,
      { defaultCurrency },
    );
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Import failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
