import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { db, schema } from "@/db";
import { eq, and } from "drizzle-orm";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import {
  COLUMN_IDS,
  FILTERABLE_COLUMN_IDS,
} from "@/lib/transactions/columns";
import { SOURCES } from "@/lib/tx-source";
import { txColumnFiltersSchema, type TxColumnFilter } from "@/lib/transactions/col-filter-schema";

/**
 * Per-user per-column filter blob for the /transactions table (issue #59).
 *
 * Stored as JSON in the generic `settings` table under
 * `key='tx_table_filters'`. Last-writer-wins. Length-bounded so a malformed
 * client can't write a megabyte to the settings table.
 *
 * Filter shape is a discriminated union by `type`:
 *  - `date`     : { from?: string, to?: string }                (YYYY-MM-DD)
 *  - `text`     : { value: string }                             (substring, case-insensitive)
 *  - `numeric`  : { op: 'eq'|'gt'|'lt'|'between', value, value2? }
 *  - `enum`     : { values: string[] }                          (multi-select)
 *
 * The page client merges these with the URL-driven top-bar quick filters
 * (date / account / category / search / portfolioHolding / tag) and pushes
 * the union to GET /api/transactions. Unknown keys are dropped on read.
 */

const KEY = "tx_table_filters";

// The filter shape lives in src/lib/transactions/col-filter-schema.ts, shared
// with saved Transactions views (GH #427).
const putSchema = z.object({
  filters: txColumnFiltersSchema,
});

export type TxFilter = TxColumnFilter;
export type TxFiltersBlob = z.infer<typeof putSchema>;

const DEFAULT: TxFiltersBlob = { filters: [] };

const SOURCE_VALUES = new Set<string>(SOURCES);

/**
 * Drop entries whose `columnId` is no longer filterable, plus any enum
 * filter on `source` whose values aren't in the SOURCES tuple — defends
 * against psql edits and stale clients.
 */
function sanitize(blob: TxFiltersBlob): TxFiltersBlob {
  const cleaned: TxFilter[] = [];
  for (const f of blob.filters) {
    if (!FILTERABLE_COLUMN_IDS.includes(f.columnId as (typeof COLUMN_IDS)[number])) continue;
    if (f.type === "enum" && f.columnId === "source") {
      const values = f.values.filter((v) => SOURCE_VALUES.has(v));
      if (values.length === 0) continue;
      cleaned.push({ ...f, values });
      continue;
    }
    cleaned.push(f);
  }
  return { filters: cleaned };
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

  if (!row[0]?.value) return NextResponse.json(DEFAULT);
  try {
    const parsed = JSON.parse(row[0].value);
    const result = putSchema.safeParse(parsed);
    if (result.success) return NextResponse.json(sanitize(result.data));
  } catch {
    // Corrupt blob — fall through to defaults.
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

  const cleaned = sanitize(parsed.data);
  const value = JSON.stringify(cleaned);

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
    return NextResponse.json(cleaned);
  } catch (error: unknown) {
    await logApiError("PUT", "/api/settings/tx-filters", error, auth.context.userId);
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to update filter preferences") },
      { status: 500 },
    );
  }
}
