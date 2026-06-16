/**
 * /api/securities/define — manage "bare" catalog securities (Tier 2).
 *
 * A security is normally created as a side-effect of a position insert
 * (resolveOrCreateSecurity dual-write). This route lets the user DEFINE a
 * security up-front from the Investments catalog tab WITHOUT picking an
 * account — it has zero positions until linked (Tab 2 / Tab 3 → POST
 * /api/securities {securityId, accountId}) and a transaction is recorded.
 *
 *   POST   — find-or-create a security from { symbol, name?, currency, isCrypto? }
 *            via the SAME clustering resolver, so a later transaction with the
 *            same ticker attaches to this row. Idempotent (returns the existing
 *            id when the cluster already exists).
 *   DELETE ?id=N — remove a security ONLY when it has no positions (409 if it is
 *            held somewhere — unlink it from Tab 2/3 first). Safe catalog cleanup.
 *
 * Auth: requireEncryption (needs the DEK to compute HMAC lookups + encrypt the
 * identity). Enveloped { success, data } on success.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";

import { db, schema } from "@/db";
import { apiHandler } from "@/lib/api-handler";
import { resolveOrCreateSecurity } from "@/lib/securities/resolve";
import { currencyCode } from "@/lib/schemas/holding";
import { isSupportedCurrency, isCryptoCurrency } from "@/lib/fx/supported-currencies";
import { symbolToCoinGeckoId } from "@/lib/crypto-service";

const defineSchema = z.object({
  symbol: z.string().trim().min(1).max(50),
  name: z.string().trim().max(200).optional(),
  currency: currencyCode,
  isCrypto: z.boolean().optional(),
});

export const POST = apiHandler(
  { auth: "encryption", body: defineSchema, fallbackMessage: "Failed to add security" },
  async ({ userId, dek, body }) => {
    // A fiat/metal currency code (USD/EUR/XAU) is a CASH position, not a
    // tradable security — those are account-bound sleeves. Reject + guide to the
    // dedicated "+ Cash" flow so we never mint a bare cash#<CCY> security with
    // no sleeve. Crypto codes (BTC/ETH) are allowed (they're real securities).
    const sym = body.symbol.trim().toUpperCase();
    const looksCrypto =
      body.isCrypto === true || symbolToCoinGeckoId(sym) != null || isCryptoCurrency(sym);
    if (!looksCrypto && isSupportedCurrency(sym)) {
      return NextResponse.json(
        {
          error:
            `“${sym}” is a currency. Add a cash position from the “By account” tab (+ Cash) instead.`,
        },
        { status: 400 },
      );
    }

    const securityId = await resolveOrCreateSecurity(userId, dek, {
      symbol: body.symbol,
      name: body.name ?? body.symbol,
      isCryptoFlag: body.isCrypto ?? false,
      isCash: false,
      currency: body.currency,
    });
    if (securityId == null) {
      return NextResponse.json(
        { error: "Couldn't classify this security — check the ticker / currency." },
        { status: 400 },
      );
    }
    return { securityId };
  },
);

export const DELETE = apiHandler(
  { auth: "encryption", fallbackMessage: "Failed to delete security" },
  async ({ request, userId }) => {
    const idRaw = request.nextUrl.searchParams.get("id");
    const id = idRaw ? parseInt(idRaw, 10) : NaN;
    if (!Number.isFinite(id) || id <= 0) {
      return NextResponse.json({ error: "Missing or invalid id" }, { status: 400 });
    }

    const sec = await db
      .select({ id: schema.securities.id })
      .from(schema.securities)
      .where(and(eq(schema.securities.id, id), eq(schema.securities.userId, userId)))
      .get();
    if (!sec) return NextResponse.json({ error: "Security not found" }, { status: 404 });

    // Refuse when any position references it — the owner unlinks from Tab 2/3
    // (which deletes tx-free positions, or refuses for positions with a ledger).
    const held = await db
      .select({ id: schema.portfolioHoldings.id })
      .from(schema.portfolioHoldings)
      .where(
        and(
          eq(schema.portfolioHoldings.securityId, id),
          eq(schema.portfolioHoldings.userId, userId),
        ),
      )
      .limit(1);
    if (held.length > 0) {
      return NextResponse.json(
        { error: "This security is held in an account; unlink it there first." },
        { status: 409 },
      );
    }

    await db
      .delete(schema.securities)
      .where(and(eq(schema.securities.id, id), eq(schema.securities.userId, userId)));
    return { success: true };
  },
);
