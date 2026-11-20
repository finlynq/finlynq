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
 *
 * Reads and writes go through custom-price-store.ts, which MCP
 * `manage_security_prices` also uses (and which stamps net-worth history dirty
 * when a manual security's marks change).
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { apiHandler } from "@/lib/api-handler";
import { isReasonableAmount } from "@/lib/utils/number";
import {
  CustomPriceError,
  deleteCustomPrices,
  listCustomPrices,
  securityIdForMark,
  upsertCustomPrices,
} from "@/lib/securities/custom-price-store";

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
    return listCustomPrices(userId, securityId);
  },
);

const postSchema = z.object({
  securityId: z.number().int().positive(),
  date: z.string().regex(ISO_DATE, "Date must be YYYY-MM-DD"),
  price: z.number().refine(isReasonableAmount, "Price is out of range"),
});

/** A store refusal as the route's existing bare error shapes (404 / 400). */
function refusal(e: unknown): NextResponse | null {
  if (!(e instanceof CustomPriceError)) return null;
  return NextResponse.json({ error: e.message }, { status: e.code === "not_found" ? 404 : 400 });
}

/**
 * POST /api/securities/prices — upsert one mark. The currency is taken from the
 * security row (not the request). One mark per (user, security, date): a repeat
 * date updates the existing mark.
 */
export const POST = apiHandler(
  { auth: "auth", body: postSchema, fallbackMessage: "Failed to save price" },
  async ({ userId, body }) => {
    try {
      const { security, ids } = await upsertCustomPrices(userId, body.securityId, [
        { date: body.date, price: body.price },
      ]);
      return { id: ids[0], securityId: body.securityId, date: body.date, price: body.price, currency: security.currency };
    } catch (e) {
      const r = refusal(e);
      if (r) return r;
      throw e;
    }
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
    const securityId = await securityIdForMark(userId, id);
    // An unknown or another user's mark: nothing to delete (unchanged behaviour).
    if (securityId != null) await deleteCustomPrices(userId, securityId, { ids: [id] });
    return { success: true };
  },
);
