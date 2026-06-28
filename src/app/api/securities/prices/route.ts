/**
 * /api/securities/prices — manual price marks for manually-priced securities.
 *
 * A security with `price_source = 'manual'` (set via PATCH /api/securities) is
 * EXCLUDED from the Yahoo/CoinGecko price API; its market value comes from the
 * per-user `custom_security_prices` marks managed here. Each mark is an
 * effective-from `(date, price)` point in the security's currency; the
 * "effective price at date D" is the latest mark on-or-before D (forward-fill).
 *
 *   GET    ?securityId=N — list this security's marks, newest first.
 *   POST   { securityId, date, price } — upsert one mark (one per (security, date)).
 *   DELETE ?id=N — remove a mark.
 *
 * Auth: requireAuth (NO DEK — prices are plain numbers, like price_cache).
 * Owner-scoped (user_id) throughout. Enveloped { success, data }.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";

import { db, schema } from "@/db";
import { apiHandler } from "@/lib/api-handler";
import { isReasonableAmount } from "@/lib/utils/number";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/securities/prices?securityId=N — the security's marks, date DESC.
 * Returns [] for an unknown / cross-user securityId.
 */
export const GET = apiHandler(
  { auth: "auth", fallbackMessage: "Failed to load prices" },
  async ({ request, userId }) => {
    const raw = request.nextUrl.searchParams.get("securityId");
    const securityId = raw ? parseInt(raw, 10) : NaN;
    if (!Number.isFinite(securityId) || securityId <= 0) {
      return NextResponse.json({ error: "Missing or invalid securityId" }, { status: 400 });
    }
    const rows = await db
      .select({
        id: schema.customSecurityPrices.id,
        date: schema.customSecurityPrices.date,
        price: schema.customSecurityPrices.price,
        currency: schema.customSecurityPrices.currency,
      })
      .from(schema.customSecurityPrices)
      .where(
        and(
          eq(schema.customSecurityPrices.userId, userId),
          eq(schema.customSecurityPrices.securityId, securityId),
        ),
      )
      .orderBy(desc(schema.customSecurityPrices.date));
    return rows.map((r) => ({ ...r, price: Number(r.price) }));
  },
);

const postSchema = z.object({
  securityId: z.number().int().positive(),
  date: z.string().regex(ISO_DATE, "Date must be YYYY-MM-DD"),
  price: z.number().refine(isReasonableAmount, "Price is out of range"),
});

/**
 * POST /api/securities/prices — upsert one mark. The currency is taken from the
 * security row (not the request). One mark per (user, security, date): a repeat
 * date updates the existing mark.
 */
export const POST = apiHandler(
  { auth: "auth", body: postSchema, fallbackMessage: "Failed to save price" },
  async ({ userId, body }) => {
    if (body.price < 0) {
      return NextResponse.json({ error: "Price cannot be negative" }, { status: 400 });
    }
    const sec = await db
      .select({ id: schema.securities.id, currency: schema.securities.currency })
      .from(schema.securities)
      .where(and(eq(schema.securities.id, body.securityId), eq(schema.securities.userId, userId)))
      .get();
    if (!sec) return NextResponse.json({ error: "Security not found" }, { status: 404 });

    const inserted = await db
      .insert(schema.customSecurityPrices)
      .values({
        userId,
        securityId: body.securityId,
        date: body.date,
        price: body.price,
        currency: sec.currency,
      })
      .onConflictDoUpdate({
        target: [
          schema.customSecurityPrices.userId,
          schema.customSecurityPrices.securityId,
          schema.customSecurityPrices.date,
        ],
        set: { price: body.price, currency: sec.currency, updatedAt: new Date() },
      })
      .returning({ id: schema.customSecurityPrices.id });
    const id = Array.isArray(inserted) ? inserted[0]?.id : undefined;
    return { id, securityId: body.securityId, date: body.date, price: body.price, currency: sec.currency };
  },
);

/**
 * DELETE /api/securities/prices?id=N — remove a mark (owner-scoped).
 */
export const DELETE = apiHandler(
  { auth: "auth", fallbackMessage: "Failed to delete price" },
  async ({ request, userId }) => {
    const raw = request.nextUrl.searchParams.get("id");
    const id = raw ? parseInt(raw, 10) : NaN;
    if (!Number.isFinite(id) || id <= 0) {
      return NextResponse.json({ error: "Missing or invalid id" }, { status: 400 });
    }
    await db
      .delete(schema.customSecurityPrices)
      .where(
        and(
          eq(schema.customSecurityPrices.id, id),
          eq(schema.customSecurityPrices.userId, userId),
        ),
      );
    return { success: true };
  },
);
