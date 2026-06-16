/**
 * POST /api/settings/backfill/fix-cash-sleeve-symbols
 *
 * Server-side hygiene fix: for every cash-sleeve holding
 * (`portfolio_holdings.is_cash=true`) where the encrypted symbol is NULL,
 * set `symbol_ct` + `symbol_lookup` from the holding's currency code.
 * e.g. a CAD cash sleeve gets symbol='CAD'.
 *
 * Context (plan `ok-bug-one-fixed-floofy-hopper.md`, Phase 4a): cash
 * sleeves often ship with the Symbol column blank because the user
 * names them like "CL - CAD" or "Fidelity - CAD" without filling the
 * separate symbol field. Setting symbol=currency makes the holdings
 * list visually unambiguous and is a precondition the user wants the
 * backfill to enforce.
 *
 * Idempotent: rows already carrying a non-null `symbol_ct` are
 * skipped. Returns the count fixed so the UI can surface a toast.
 *
 * Auth: requireEncryption — needs the DEK to encrypt the symbol value.
 * Scope: the authenticated user only; no admin / cross-tenant ops.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { encryptName, decryptName } from "@/lib/crypto/encrypted-columns";
import { resolveOrCreateSecurity, gcOrphanSecurity } from "@/lib/securities/resolve";
import { safeErrorMessage, logApiError } from "@/lib/validate";

export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;
  try {
    // 1. Find cash sleeves with no symbol set.
    const targets = await db
      .select({
        id: schema.portfolioHoldings.id,
        currency: schema.portfolioHoldings.currency,
        symbolCt: schema.portfolioHoldings.symbolCt,
        nameCt: schema.portfolioHoldings.nameCt,
        securityId: schema.portfolioHoldings.securityId,
        isCrypto: schema.portfolioHoldings.isCrypto,
      })
      .from(schema.portfolioHoldings)
      .where(
        and(
          eq(schema.portfolioHoldings.userId, userId),
          eq(schema.portfolioHoldings.isCash, true),
        ),
      );
    const missing = targets.filter((h) => h.symbolCt == null || h.symbolCt === "");

    if (missing.length === 0) {
      return NextResponse.json({ ok: true, fixed: 0, total: targets.length });
    }

    // 2. Encrypt each currency code under the user's DEK and UPDATE.
    //    One round-trip per holding — number of cash sleeves per user is
    //    small (one per (account, currency)), so this stays cheap.
    let fixed = 0;
    for (const h of missing) {
      const enc = encryptName(dek, h.currency);
      if (enc.ct == null) continue; // currency is empty string somehow — skip
      await db
        .update(schema.portfolioHoldings)
        .set({
          symbolCt: enc.ct,
          symbolLookup: enc.lookup,
        })
        .where(
          and(
            eq(schema.portfolioHoldings.id, h.id),
            eq(schema.portfolioHoldings.userId, userId),
          ),
        );
      // Securities master: stamping a symbol on a metal sleeve (currency XAU/…)
      // moves its cluster from cash#<CCY> to metal:<hmac>, so re-resolve and
      // re-point security_id. Plain fiat cash sleeves resolve to the SAME
      // security (cluster keyed on currency) → no-op. Mirrors the PUT path.
      const resolved = await resolveOrCreateSecurity(userId, dek, {
        symbol: h.currency,
        name: decryptName(h.nameCt, dek, null),
        isCryptoFlag: (h.isCrypto ?? 0) === 1,
        isCash: true,
        currency: h.currency,
      });
      const oldSecurityId = h.securityId ?? null;
      if (resolved != null && resolved !== oldSecurityId) {
        await db
          .update(schema.portfolioHoldings)
          .set({ securityId: resolved })
          .where(
            and(
              eq(schema.portfolioHoldings.id, h.id),
              eq(schema.portfolioHoldings.userId, userId),
            ),
          );
        await gcOrphanSecurity(userId, oldSecurityId);
      }
      fixed += 1;
    }

    return NextResponse.json({ ok: true, fixed, total: targets.length });
  } catch (err: unknown) {
    await logApiError("POST", "/api/settings/backfill/fix-cash-sleeve-symbols", err, auth.userId);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Failed to fix cash-sleeve symbols") },
      { status: 500 },
    );
  }
}
