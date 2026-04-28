/**
 * FX overrides API — per-user manual rate pins.
 *
 * Storage shape: each row stores `rate_to_usd` (1 unit of currency = N USD)
 * over a date range. The user-friendly UI accepts "1 EUR = 1.10 USD" and
 * converts internally; for non-USD pairs they have to be entered as two
 * USD-anchored rows (one per currency leg).
 *
 * GET: list user's overrides
 * POST: create one
 * PATCH: update by id
 * DELETE: remove by id
 *
 * No DEK required — overrides are user-owned but plaintext (rates aren't
 * sensitive in the way payee text is).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { logApiError, safeErrorMessage, validateBody } from "@/lib/validate";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  const rows = await db
    .select()
    .from(schema.fxOverrides)
    .where(eq(schema.fxOverrides.userId, auth.context.userId))
    .orderBy(schema.fxOverrides.currency, schema.fxOverrides.dateFrom);
  return NextResponse.json(rows);
}

const isoCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3,4}$/, "Must be a 3-letter ISO 4217 code");

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");

const postSchema = z.object({
  currency: isoCode,
  rateToUsd: z.number().positive(),
  dateFrom: isoDate,
  dateTo: isoDate.nullish(),
  note: z.string().max(500).optional(),
});

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = validateBody(body, postSchema);
  if (parsed.error) return parsed.error;
  const data = parsed.data;

  if (data.currency === "USD") {
    return NextResponse.json(
      { error: "USD is the anchor currency — cannot override" },
      { status: 400 }
    );
  }

  try {
    const inserted = await db
      .insert(schema.fxOverrides)
      .values({
        userId,
        currency: data.currency,
        dateFrom: data.dateFrom,
        dateTo: data.dateTo ?? null,
        rateToUsd: data.rateToUsd,
        note: data.note ?? "",
      })
      .returning();
    return NextResponse.json(inserted[0], { status: 201 });
  } catch (error: unknown) {
    await logApiError("POST", "/api/fx/overrides", error, userId);
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to create override") },
      { status: 500 }
    );
  }
}

const patchSchema = z.object({
  id: z.number().int().positive(),
  rateToUsd: z.number().positive().optional(),
  dateFrom: isoDate.optional(),
  dateTo: isoDate.nullish(),
  note: z.string().max(500).optional(),
});

export async function PATCH(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = validateBody(body, patchSchema);
  if (parsed.error) return parsed.error;
  const { id, ...data } = parsed.data;

  try {
    const updated = await db
      .update(schema.fxOverrides)
      .set(data)
      .where(
        and(
          eq(schema.fxOverrides.id, id),
          eq(schema.fxOverrides.userId, userId)
        )
      )
      .returning();
    if (!updated[0]) {
      return NextResponse.json({ error: "Override not found" }, { status: 404 });
    }
    return NextResponse.json(updated[0]);
  } catch (error: unknown) {
    await logApiError("PATCH", "/api/fx/overrides", error, userId);
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to update override") },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  const idParam = request.nextUrl.searchParams.get("id");
  const id = idParam ? parseInt(idParam) : null;
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  await db
    .delete(schema.fxOverrides)
    .where(
      and(
        eq(schema.fxOverrides.id, id),
        eq(schema.fxOverrides.userId, userId)
      )
    );
  return NextResponse.json({ ok: true });
}
