import { NextRequest, NextResponse } from "next/server";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { summarizeMoneyProCsv } from "@/lib/external-import/moneypro-orchestrator";
import { moneypro } from "@finlynq/import-connectors";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * POST /api/import/connectors/moneypro/preview
 * Multipart form: `file` (the Money Pro CSV), optional `defaultCurrency`.
 * Read-only — parses + summarizes (account plan, categories, transfer count,
 * row errors) so the user can map accounts before committing. No DB writes.
 */
export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;

  const form = await request.formData();
  const file = form.get("file");
  const defaultCurrencyRaw = form.get("defaultCurrency");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing 'file' form field" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "CSV exceeds 10 MB" }, { status: 413 });
  }

  const text = await file.text();
  const headers = moneypro.moneyProHeaders(text);
  if (!moneypro.isMoneyProCsv(headers)) {
    return NextResponse.json(
      {
        error:
          "This doesn't look like a Money Pro export. The CSV should include the columns Transaction Type, Amount received, and Account (to).",
        headers,
      },
      { status: 400 },
    );
  }

  const defaultCurrency =
    typeof defaultCurrencyRaw === "string" && defaultCurrencyRaw.trim()
      ? defaultCurrencyRaw.trim().toUpperCase()
      : undefined;

  try {
    const summary = await summarizeMoneyProCsv(text, auth.userId, auth.dek, {
      defaultCurrency,
    });
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Preview failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
