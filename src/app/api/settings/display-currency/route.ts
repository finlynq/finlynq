import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { db, schema } from "@/db";
import { eq, and } from "drizzle-orm";
import { isReportableCurrency } from "@/lib/fx/supported-currencies";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import {
  setDisplayCurrency,
  DEFAULT_DISPLAY_CURRENCY,
} from "@/lib/settings/display-currency";

const DEFAULT_CURRENCY = DEFAULT_DISPLAY_CURRENCY;

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  const row = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(
      and(
        eq(schema.settings.key, "display_currency"),
        eq(schema.settings.userId, auth.context.userId)
      )
    )
    .limit(1);
  const displayCurrency = row[0]?.value ?? DEFAULT_CURRENCY;
  return NextResponse.json({ displayCurrency });
}

const putSchema = z.object({
  displayCurrency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "Must be a 3-letter ISO 4217 code"),
});

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = validateBody(body, putSchema);
  if (parsed.error) return parsed.error;
  const { displayCurrency } = parsed.data;

  // Validates against the REPORTABLE set, not `isSupportedCurrency`. The latter
  // also answers "is this ticker cash rather than a stock", and several
  // reportable codes are live equity/ETF tickers (AED = Aegon, SAR = Saratoga),
  // so the two lists must stay separate — see supported-currencies.ts. A code
  // outside the reportable set has no live quote, and FX resolution ends in a
  // `rate = 1` fallback rather than an error, so accepting it would silently
  // report every total at 1:1. The custom-rate path is the escape hatch, and
  // `useDisplayCurrencyOptions` surfaces those currencies in the picker.
  if (!isReportableCurrency(displayCurrency)) {
    return NextResponse.json(
      {
        error: `Currency ${displayCurrency} has no live exchange rate. Add a custom rate via Settings → Custom exchange rates first.`,
        code: "currency-unsupported",
      },
      { status: 400 }
    );
  }

  try {
    // FINLYNQ-301 — one shared writer for both this route and the display-
    // currency decision prompt: upsert on (key, userId) + recompute reporting
    // amounts only on a real change. Behaviour is identical to the prior inline
    // block (the recompute is still fire-and-forget inside the helper).
    const { changed } = await setDisplayCurrency(
      db,
      auth.context.userId,
      displayCurrency
    );

    return NextResponse.json({ displayCurrency, recomputing: changed });
  } catch (error: unknown) {
    await logApiError("PUT", "/api/settings/display-currency", error, auth.context.userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to update display currency") }, { status: 500 });
  }
}
