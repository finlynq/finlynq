import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { getPortfolioHoldings } from "@/lib/queries";
import { requireAuth } from "@/lib/auth/require-auth";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { z } from "zod";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import { buildNameFields, nameLookup } from "@/lib/crypto/encrypted-columns";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const data = await getPortfolioHoldings(auth.context.userId);
  return NextResponse.json(data);
}

// Currency: any 3-4 letter ISO 4217 code, normalized to uppercase. Was
// previously z.enum(["CAD","USD"]) which silently rejected EUR/GBP/BTC etc.
// — fixed 2026-04-27 alongside the holding-currency redesign.
const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3,4}$/, "Currency must be a 3-4 letter ISO 4217 code");

const postSchema = z.object({
  name: z.string().min(1).max(200),
  accountId: z.number().int(),
  symbol: z.string().max(50).nullable().optional(),
  currency: currencyCode.optional(),
  isCrypto: z.boolean().optional(),
  note: z.string().max(500).optional(),
});

/**
 * POST /api/portfolio — create a new portfolio holding.
 *
 * Stream D dual-write: persists name_ct/name_lookup + symbol_ct/symbol_lookup
 * alongside the plaintext columns. Requires an unlocked session DEK because
 * Phase 3 prod has plaintext NULL'd on existing rows; writing plaintext-only
 * here would create a row that's invisible to every other read path.
 */
export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json();
    const parsed = validateBody(body, postSchema);
    if (parsed.error) return parsed.error;
    const { name, accountId, symbol, currency, isCrypto, note } = parsed.data;

    const acct = await db
      .select({ id: schema.accounts.id, currency: schema.accounts.currency })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.userId, auth.userId)))
      .get();
    if (!acct) return NextResponse.json({ error: "Account not found" }, { status: 404 });

    // Pre-check duplicate against name_lookup (HMAC) — partial UNIQUE on
    // (user_id, account_id, name_lookup) is the DB backstop, but a friendly
    // pre-check beats raising 23505.
    const lookup = nameLookup(auth.dek, name);
    const dup = await db
      .select({ id: schema.portfolioHoldings.id })
      .from(schema.portfolioHoldings)
      .where(
        and(
          eq(schema.portfolioHoldings.userId, auth.userId),
          eq(schema.portfolioHoldings.accountId, accountId),
          eq(schema.portfolioHoldings.nameLookup, lookup),
        ),
      )
      .get();
    if (dup) {
      return NextResponse.json(
        { error: `Holding "${name}" already exists in this account` },
        { status: 409 },
      );
    }

    const symbolValue = symbol && symbol.trim() ? symbol.trim() : null;
    const enc = buildNameFields(auth.dek, { name, symbol: symbolValue });

    try {
      const holding = await db
        .insert(schema.portfolioHoldings)
        .values({
          name,
          symbol: symbolValue,
          accountId,
          currency: currency ?? acct.currency ?? "CAD",
          isCrypto: isCrypto ? 1 : 0,
          note: note ?? "",
          userId: auth.userId,
          ...enc,
        })
        .returning()
        .get();
      return NextResponse.json(holding, { status: 201 });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("23505") || msg.toLowerCase().includes("unique")) {
        return NextResponse.json(
          { error: `Holding "${name}" already exists in this account` },
          { status: 409 },
        );
      }
      throw error;
    }
  } catch (error: unknown) {
    await logApiError("POST", "/api/portfolio", error, auth.userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to create holding") }, { status: 500 });
  }
}

const putSchema = z.object({
  id: z.number(),
  name: z.string().min(1).max(200).optional(),
  symbol: z.string().max(50).nullable().optional(),
  currency: currencyCode.optional(),
  isCrypto: z.number().int().min(0).max(1).optional(),
  note: z.string().max(500).optional(),
});

/**
 * PUT /api/portfolio — update an existing portfolio holding.
 *
 * Renames cascade to all transactions automatically because the portfolio
 * aggregator groups by `transactions.portfolio_holding_id` (integer FK) and
 * JOINs to `portfolio_holdings` for the display name. The legacy text column
 * `transactions.portfolio_holding` is the orphan-fallback path only.
 *
 * Stream D dual-write: name_ct/name_lookup + symbol_ct/symbol_lookup are
 * regenerated whenever name or symbol changes. Requires an unlocked session
 * DEK — see POST docstring above.
 */
export async function PUT(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json();
    const parsed = validateBody(body, putSchema);
    if (parsed.error) return parsed.error;
    const { id, ...data } = parsed.data;

    const existing = await db
      .select({ id: schema.portfolioHoldings.id })
      .from(schema.portfolioHoldings)
      .where(
        and(
          eq(schema.portfolioHoldings.id, id),
          eq(schema.portfolioHoldings.userId, auth.userId),
        ),
      )
      .get();
    if (!existing) {
      return NextResponse.json({ error: "Holding not found" }, { status: 404 });
    }

    // buildNameFields takes only the keys we want to re-encrypt — name and/or
    // symbol — and returns { nameCt, nameLookup, symbolCt, symbolLookup } as
    // appropriate. Spread alongside the plaintext UPDATE.
    const encFields: Record<string, string | null> = {};
    if (data.name !== undefined) {
      Object.assign(encFields, buildNameFields(auth.dek, { name: data.name }));
    }
    if (data.symbol !== undefined) {
      const symbolValue = data.symbol && data.symbol.trim() ? data.symbol.trim() : null;
      data.symbol = symbolValue;
      Object.assign(encFields, buildNameFields(auth.dek, { symbol: symbolValue }));
    }

    try {
      const updated = await db
        .update(schema.portfolioHoldings)
        .set({ ...data, ...encFields })
        .where(
          and(
            eq(schema.portfolioHoldings.id, id),
            eq(schema.portfolioHoldings.userId, auth.userId),
          ),
        )
        .returning()
        .get();
      return NextResponse.json(updated);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("23505") || msg.toLowerCase().includes("unique")) {
        return NextResponse.json(
          { error: "Another holding with this name already exists in this account" },
          { status: 409 },
        );
      }
      throw error;
    }
  } catch (error: unknown) {
    await logApiError("PUT", "/api/portfolio", error, auth.userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to update holding") }, { status: 500 });
  }
}

/**
 * DELETE /api/portfolio?id=N — remove a holding.
 *
 * The FK `transactions.portfolio_holding_id … ON DELETE SET NULL` auto-NULLs
 * referencing rows. Transactions survive (no data loss) and fall back to the
 * orphan-aggregation path until reassigned. The response reports the count
 * of unlinked transactions for transparency.
 */
export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const id = parseInt(request.nextUrl.searchParams.get("id") ?? "0");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  try {
    // Count referencing transactions before delete so we can report it.
    const txnCount = await db
      .select({ cnt: sql<number>`COUNT(*)` })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, auth.context.userId),
          eq(schema.transactions.portfolioHoldingId, id),
        ),
      )
      .get();
    const unlinked = Number(txnCount?.cnt ?? 0);

    const result = await db
      .delete(schema.portfolioHoldings)
      .where(
        and(
          eq(schema.portfolioHoldings.id, id),
          eq(schema.portfolioHoldings.userId, auth.context.userId),
        ),
      )
      .returning({ id: schema.portfolioHoldings.id })
      .all();
    if (result.length === 0) {
      return NextResponse.json({ error: "Holding not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true, unlinkedTransactions: unlinked });
  } catch (error: unknown) {
    await logApiError("DELETE", "/api/portfolio", error, auth.context.userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to delete holding") }, { status: 500 });
  }
}
