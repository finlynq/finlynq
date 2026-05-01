import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { db, schema } from "@/db";
import { eq, and } from "drizzle-orm";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import {
  COLUMN_IDS,
  DEFAULT_COLUMNS,
  type ColumnId,
} from "@/lib/transactions/columns";

/**
 * Per-user preferences for the /transactions table column layout.
 *
 * Persisted as a single JSON blob in the generic `settings` table under
 * `key='tx_table_columns'`. Mirrors the pattern set by display-currency
 * (`src/app/api/settings/display-currency/route.ts`) — last-writer-wins on
 * concurrent edits is acceptable for column prefs (rarely concurrent).
 *
 * The frontend migrates the legacy `localStorage["pf-tx-cols-v1"]` value on
 * first load, then writes back to this endpoint and clears the localStorage
 * key — so column prefs follow the user across devices.
 *
 * Issue #59: COLUMN_IDS is now sourced from `@/lib/transactions/columns`
 * (shared with the GET /api/transactions sort whitelist + the page client +
 * the sibling tx-sort / tx-filters routes). Adding a new column means
 * extending that module and the rendering branch in transactions/page.tsx.
 * Removing one is the same in reverse — old saved blobs simply ignore
 * unknown ids.
 */

const KEY = "tx_table_columns";

const columnEntrySchema = z.object({
  id: z.enum(COLUMN_IDS),
  visible: z.boolean(),
});

const putSchema = z.object({
  // Length-bounded to a multiple of the column count so a malformed client
  // can't write a megabyte of garbage to the settings table.
  columns: z.array(columnEntrySchema).min(1).max(COLUMN_IDS.length * 2),
});

type Persisted = { columns: Array<{ id: ColumnId; visible: boolean }> };

/**
 * Merge a user's saved blob with the canonical default list:
 * - any default column missing from the saved blob is appended (visibility
 *   from defaults). Lets us add a new column without forcing a migration.
 * - any saved column not in COLUMN_IDS is dropped — Zod already filtered
 *   these on the way in, but a manual psql edit could slip one through.
 * - duplicates in the saved blob are de-duped, first occurrence wins.
 */
function mergeWithDefaults(saved: Persisted | null): Persisted {
  if (!saved) return { columns: DEFAULT_COLUMNS };
  const seen = new Set<ColumnId>();
  const merged: Array<{ id: ColumnId; visible: boolean }> = [];
  for (const entry of saved.columns) {
    if (!COLUMN_IDS.includes(entry.id)) continue;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push({ id: entry.id, visible: entry.visible });
  }
  for (const def of DEFAULT_COLUMNS) {
    if (seen.has(def.id)) continue;
    merged.push(def);
  }
  return { columns: merged };
}

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

  let saved: Persisted | null = null;
  if (row[0]?.value) {
    try {
      const parsed = JSON.parse(row[0].value);
      const result = z.object({ columns: z.array(columnEntrySchema) }).safeParse(parsed);
      if (result.success) saved = result.data as Persisted;
    } catch {
      // Corrupt JSON in the column — fall through to defaults rather than
      // 500'ing the whole page. The user re-saves and the row gets fixed.
    }
  }
  return NextResponse.json(mergeWithDefaults(saved));
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

  // De-dupe + merge with defaults BEFORE persisting so the stored blob is
  // self-consistent and any future schema additions (new column id) get
  // appended automatically without a forced migration.
  const merged = mergeWithDefaults({ columns: parsed.data.columns });
  const value = JSON.stringify(merged);

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
    return NextResponse.json(merged);
  } catch (error: unknown) {
    await logApiError("PUT", "/api/settings/tx-columns", error, auth.context.userId);
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to update column preferences") },
      { status: 500 },
    );
  }
}
