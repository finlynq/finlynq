import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { db, schema } from "@/db";
import { eq, and } from "drizzle-orm";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import { SORTABLE_COLUMN_IDS } from "@/lib/transactions/columns";

/**
 * Per-user sort preference for the /transactions table (issue #59).
 *
 * Stored as a single JSON blob in the generic `settings` table under
 * `key='tx_table_sort'`. Mirrors the tx-columns shape — last-writer-wins
 * is acceptable. The frontend writes this on every header click so the
 * current sort follows the user across devices.
 *
 * `direction = null` clears the sort (third-click behavior). When no row
 * exists or `direction` is null, GET /api/transactions falls back to the
 * default `date DESC`.
 */

const KEY = "tx_table_sort";

// `null` is allowed as the cleared state. zod's `.nullable()` covers it.
const putSchema = z.object({
  columnId: z.enum(SORTABLE_COLUMN_IDS).nullable(),
  direction: z.enum(["asc", "desc"]).nullable(),
});

type Persisted = z.infer<typeof putSchema>;

const DEFAULT: Persisted = { columnId: null, direction: null };

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  const row = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(
      and(
        eq(schema.settings.key, KEY),
        eq(schema.settings.userId, auth.context.userId),
      ),
    )
    .limit(1);

  if (!row[0]?.value) return NextResponse.json(DEFAULT);
  try {
    const parsed = JSON.parse(row[0].value);
    const result = putSchema.safeParse(parsed);
    if (result.success) return NextResponse.json(result.data);
  } catch {
    // Fall through to default — corrupt blob shouldn't 500 the page.
  }
  return NextResponse.json(DEFAULT);
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
  const parsed = validateBody(body, putSchema);
  if (parsed.error) return parsed.error;

  // Cleared state — both fields null. Normalize so callers that send only
  // one of them still land on a consistent shape.
  const normalized: Persisted =
    parsed.data.columnId == null || parsed.data.direction == null
      ? DEFAULT
      : parsed.data;
  const value = JSON.stringify(normalized);

  try {
    await db
      .insert(schema.settings)
      .values({
        key: KEY,
        userId: auth.context.userId,
        value,
      })
      .onConflictDoUpdate({
        target: [schema.settings.key, schema.settings.userId],
        set: { value },
      });
    return NextResponse.json(normalized);
  } catch (error: unknown) {
    await logApiError("PUT", "/api/settings/tx-sort", error, auth.context.userId);
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to update sort preference") },
      { status: 500 },
    );
  }
}
