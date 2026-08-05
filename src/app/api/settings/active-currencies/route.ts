/**
 * Active currencies — the user's preferred subset of supported currencies.
 *
 * Used to scope:
 *  - The currency dropdown in transaction/account/subscription forms.
 *  - The prewarm list for FX rate fetching (don't fetch CNY rates if the
 *    user has never used CNY).
 *
 * Defaults to the union of currencies-derived-from-data (accounts.currency
 * and transactions.currency) plus the user's display currency. Stored in
 * settings keyed `active_currencies` as a JSON array of ISO codes.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/settings/display-currency";
import { logApiError, safeErrorMessage, validateBody } from "@/lib/validate";

const KEY = "active_currencies";

async function readActive(userId: string): Promise<string[] | null> {
  const row = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(
      and(
        eq(schema.settings.key, KEY),
        eq(schema.settings.userId, userId)
      )
    )
    .limit(1);
  if (!row[0]?.value) return null;
  try {
    const parsed = JSON.parse(row[0].value);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) return parsed;
  } catch { /* fall through */ }
  return null;
}

async function readDisplay(userId: string): Promise<string> {
  const row = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(
      and(
        eq(schema.settings.key, "display_currency"),
        eq(schema.settings.userId, userId)
      )
    )
    .limit(1);
  // FINLYNQ-183: the app-wide default is USD, never CAD. This fallback is what
  // a user with no `display_currency` row derives their whole active set from,
  // so a stale CAD here seeded every currency dropdown with the wrong code.
  return row[0]?.value ?? DEFAULT_DISPLAY_CURRENCY;
}

async function deriveFromData(userId: string): Promise<string[]> {
  const accountRows = await db
    .select({ currency: schema.accounts.currency })
    .from(schema.accounts)
    .where(eq(schema.accounts.userId, userId))
    .groupBy(schema.accounts.currency);
  const txRows = await db
    .select({ currency: schema.transactions.currency })
    .from(schema.transactions)
    .where(eq(schema.transactions.userId, userId))
    .groupBy(schema.transactions.currency);
  const set = new Set<string>();
  for (const r of accountRows) if (r.currency) set.add(r.currency.toUpperCase());
  for (const r of txRows) if (r.currency) set.add(r.currency.toUpperCase());
  // Records that carry their OWN currency count as "in use" too (2026-08-05).
  // Accounts and transactions alone missed money the user genuinely holds in a
  // currency: a RUB loan (or goal/subscription/budget) for someone with no RUB
  // account left RUB out of every dropdown, so they could not create another
  // one from the web — the form's `ensure` only force-includes the value a
  // record ALREADY has. Same omission as `getActiveCurrencies` in fx-service.
  for (const table of [schema.loans, schema.goals, schema.subscriptions, schema.budgets]) {
    const rows = await db
      .select({ currency: table.currency })
      .from(table)
      .where(eq(table.userId, userId))
      .groupBy(table.currency);
    for (const r of rows) if (r.currency) set.add(r.currency.toUpperCase());
  }
  return Array.from(set);
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  const explicit = await readActive(userId);
  if (explicit) {
    return NextResponse.json({ active: explicit, source: "saved" });
  }

  // Derive defaults from existing data + display currency.
  const fromData = await deriveFromData(userId);
  const display = await readDisplay(userId);
  const merged = Array.from(new Set([display.toUpperCase(), ...fromData]));
  return NextResponse.json({ active: merged, source: "derived" });
}

const putSchema = z.object({
  active: z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{3,4}$/)).min(1).max(50),
});

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = validateBody(body, putSchema);
  if (parsed.error) return parsed.error;

  // Allow non-supported codes — they'll need an override to be useful, but
  // we don't block adding (e.g.) XAU here. The override UI handles those.
  const dedup = Array.from(new Set(parsed.data.active));

  try {
    await db
      .insert(schema.settings)
      .values({ key: KEY, userId, value: JSON.stringify(dedup) })
      .onConflictDoUpdate({
        target: [schema.settings.key, schema.settings.userId],
        set: { value: JSON.stringify(dedup) },
      });
    return NextResponse.json({ active: dedup });
  } catch (error: unknown) {
    await logApiError("PUT", "/api/settings/active-currencies", error, userId);
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to save active currencies") },
      { status: 500 }
    );
  }
}
