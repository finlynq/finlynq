/**
 * GET/PUT /api/settings/confirm-csv-mapping — statement-upload field-mapping
 * §B per-user default (2026-06-04).
 *
 * "Confirm detected column mapping before importing" — the user-level default
 * that seeds the per-account `accounts.csv_mapping_mode` for accounts the user
 * hasn't explicitly set. Stored as the `confirm_csv_mapping` key in the
 * `settings` key/value table (mirrors dev-mode). Default ON ("true").
 *
 * The upload route decides "confirm vs auto" per upload by reading the bound
 * account's `csv_mapping_mode` column first; this setting is only the fallback
 * default that gets baked into NEW accounts at creation time (and reads as the
 * effective default if an account column is ever NULL). See
 * src/app/api/import/staging/upload/route.ts for the decision rule.
 *
 * Request body (JSON): { confirmCsvMapping: boolean }
 * Response: { confirmCsvMapping: boolean }
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

const SETTING_KEY = "confirm_csv_mapping";

/** Read the per-user default. Defaults to true (confirm ON) when unset. */
export async function getConfirmCsvMappingDefault(userId: string): Promise<boolean> {
  const row = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(
      and(
        eq(schema.settings.key, SETTING_KEY),
        eq(schema.settings.userId, userId),
      ),
    )
    .get();
  // Unset → default ON (the new safe behavior). Only an explicit "false"
  // opts out.
  return row?.value !== "false";
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  const confirmCsvMapping = await getConfirmCsvMappingDefault(auth.context.userId);
  return NextResponse.json({ confirmCsvMapping });
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const confirmCsvMapping = (body as { confirmCsvMapping?: unknown } | null)
    ?.confirmCsvMapping === true;
  const value = confirmCsvMapping ? "true" : "false";

  await db
    .insert(schema.settings)
    .values({ key: SETTING_KEY, userId: auth.context.userId, value })
    .onConflictDoUpdate({
      target: [schema.settings.key, schema.settings.userId],
      set: { value },
    });

  return NextResponse.json({ confirmCsvMapping });
}
