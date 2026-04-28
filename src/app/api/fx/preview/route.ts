/**
 * GET /api/fx/preview?from=EUR&to=USD&date=2026-04-27&amount=100
 *
 * Returns a live conversion preview for the transaction edit dialog —
 * shows the user what their entered amount maps to in the account's
 * currency, plus the rate's source so they can see whether it's a fresh
 * Yahoo fetch, a cached value, or a custom override.
 *
 * Read-only, auth required, no DEK needed.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { getRateToUsdDetailed } from "@/lib/fx-service";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  const params = request.nextUrl.searchParams;
  const from = (params.get("from") ?? "").trim().toUpperCase();
  const to = (params.get("to") ?? "").trim().toUpperCase();
  const date = params.get("date") ?? new Date().toISOString().split("T")[0];
  const amountParam = params.get("amount");
  const amount = amountParam != null ? parseFloat(amountParam) : null;

  if (!/^[A-Z]{3,4}$/.test(from) || !/^[A-Z]{3,4}$/.test(to)) {
    return NextResponse.json(
      { error: "from and to must be 3-letter ISO 4217 codes" },
      { status: 400 }
    );
  }

  if (from === to) {
    return NextResponse.json({
      from, to, date,
      rate: 1,
      source: "identity",
      amount: amount ?? null,
      converted: amount ?? null,
    });
  }

  const fromUsd = await getRateToUsdDetailed(from, date, auth.context.userId);
  const toUsd = await getRateToUsdDetailed(to, date, auth.context.userId);

  if (toUsd.rate === 0) {
    return NextResponse.json(
      { error: `Cannot convert into ${to} (rate is zero)` },
      { status: 409 }
    );
  }

  const rate = fromUsd.rate / toUsd.rate;
  const source =
    fromUsd.source === "fallback" || toUsd.source === "fallback" ? "fallback"
      : fromUsd.source === "stale" || toUsd.source === "stale" ? "stale"
      : fromUsd.source === "override" || toUsd.source === "override" ? "override"
      : fromUsd.source;

  return NextResponse.json({
    from, to, date,
    rate: Math.round(rate * 100000000) / 100000000,
    source,
    amount,
    converted: amount != null ? Math.round(amount * rate * 100) / 100 : null,
    legs: { from: fromUsd, to: toUsd },
    needsOverride: source === "fallback",
  });
}
