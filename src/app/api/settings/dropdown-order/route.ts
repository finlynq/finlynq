/**
 * Dropdown order — per-user customizable ordering for app dropdowns.
 *
 * Used by the shared <Combobox> primitive (via DropdownOrderProvider) to pin
 * frequently-used categories / accounts / holdings / currencies to the top of
 * each list. Stored as JSON in `settings.value` keyed `dropdown_order`. No
 * schema migration — rides the existing `settings` (key, userId, value) table.
 *
 * Privacy: the JSON contains only opaque identifiers — numeric IDs for
 * accounts/holdings, ISO codes for currencies, HMAC `name_lookup` hashes for
 * categories. No display names enter the settings row, so the value is not
 * encrypted and `requireAuth` is sufficient (no `requireEncryption`).
 *
 * See issue #21.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";

import { requireAuth } from "@/lib/auth/require-auth";
import { db, schema } from "@/db";
import { logApiError, safeErrorMessage, validateBody } from "@/lib/validate";
import {
  EMPTY_DROPDOWN_ORDER,
  parseDropdownOrder,
  type DropdownOrder,
} from "@/lib/dropdown-order";

const KEY = "dropdown_order";

const MAX_ENTRIES_PER_LIST = 5000;

const entrySchema = z.union([z.string().min(1).max(256), z.number().int()]);

const putSchema = z.object({
  version: z.literal(1).optional(),
  lists: z
    .object({
      category: z.array(entrySchema).max(MAX_ENTRIES_PER_LIST).optional(),
      account: z.array(entrySchema).max(MAX_ENTRIES_PER_LIST).optional(),
      holding: z.array(entrySchema).max(MAX_ENTRIES_PER_LIST).optional(),
      currency: z.array(entrySchema).max(MAX_ENTRIES_PER_LIST).optional(),
    })
    .strict(),
});

async function readRow(userId: string): Promise<DropdownOrder> {
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
  if (!row[0]?.value) return EMPTY_DROPDOWN_ORDER;
  try {
    const parsed = parseDropdownOrder(JSON.parse(row[0].value));
    return parsed ?? EMPTY_DROPDOWN_ORDER;
  } catch {
    return EMPTY_DROPDOWN_ORDER;
  }
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  const order = await readRow(userId);
  return NextResponse.json(order);
}

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

  const lists: DropdownOrder["lists"] = {};
  for (const [kind, ids] of Object.entries(parsed.data.lists)) {
    if (!ids) continue;
    lists[kind as keyof DropdownOrder["lists"]] = Array.from(new Set(ids));
  }

  const next: DropdownOrder = { version: 1, lists };

  try {
    await db
      .insert(schema.settings)
      .values({ key: KEY, userId, value: JSON.stringify(next) })
      .onConflictDoUpdate({
        target: [schema.settings.key, schema.settings.userId],
        set: { value: JSON.stringify(next) },
      });
    return NextResponse.json(next);
  } catch (error: unknown) {
    await logApiError("PUT", "/api/settings/dropdown-order", error, userId);
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to save dropdown order") },
      { status: 500 }
    );
  }
}
