import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getPortfolioHoldings } from "@/lib/queries";
import { requireAuth } from "@/lib/auth/require-auth";
import { z } from "zod";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const data = await getPortfolioHoldings(auth.context.userId);
  return NextResponse.json(data);
}

const putSchema = z.object({
  id: z.number(),
  name: z.string().min(1).max(200).optional(),
  symbol: z.string().max(50).nullable().optional(),
  currency: z.string().min(3).max(10).optional(),
  isCrypto: z.number().int().min(0).max(1).optional(),
  note: z.string().max(500).optional(),
});

/**
 * PUT /api/portfolio — update an existing portfolio holding.
 *
 * Note: `name` is the join key used by the portfolio overview aggregator
 * (tx.portfolio_holding = portfolio_holdings.name). Renaming here does NOT
 * rewrite existing transactions — their portfolio_holding string still
 * points at the old name, so they become orphans in the aggregator until
 * the user renames them too (or re-imports). We don't cascade that rename
 * because tx.portfolio_holding is encrypted and cascading would require
 * decrypt/re-encrypt every row; safer to surface it as a known tradeoff.
 */
export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  try {
    const body = await request.json();
    const parsed = validateBody(body, putSchema);
    if (parsed.error) return parsed.error;
    const { id, ...data } = parsed.data;

    // Ownership pre-check — zero-row UPDATE would otherwise silently no-op.
    const existing = await db
      .select({ id: schema.portfolioHoldings.id })
      .from(schema.portfolioHoldings)
      .where(
        and(
          eq(schema.portfolioHoldings.id, id),
          eq(schema.portfolioHoldings.userId, auth.context.userId),
        ),
      )
      .get();
    if (!existing) {
      return NextResponse.json({ error: "Holding not found" }, { status: 404 });
    }

    const updated = await db
      .update(schema.portfolioHoldings)
      .set(data)
      .where(
        and(
          eq(schema.portfolioHoldings.id, id),
          eq(schema.portfolioHoldings.userId, auth.context.userId),
        ),
      )
      .returning()
      .get();
    return NextResponse.json(updated);
  } catch (error: unknown) {
    await logApiError("PUT", "/api/portfolio", error, auth.context.userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to update holding") }, { status: 500 });
  }
}

/**
 * DELETE /api/portfolio?id=N — remove a holding. Transactions that reference
 * the holding by name are NOT rewritten; they stay in place but stop
 * aggregating into this row (they'll be counted as "auto-detected" orphans
 * until cleaned up manually).
 */
export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const id = parseInt(request.nextUrl.searchParams.get("id") ?? "0");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  try {
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
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    await logApiError("DELETE", "/api/portfolio", error, auth.context.userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to delete holding") }, { status: 500 });
  }
}
