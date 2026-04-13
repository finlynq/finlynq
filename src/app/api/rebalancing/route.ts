import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { safeErrorMessage } from "@/lib/validate";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  const targets = await db.select().from(schema.targetAllocations).where(eq(schema.targetAllocations.userId, userId)).all();

  // Get portfolio holdings with cached prices
  const holdings = await db
    .select({
      id: schema.portfolioHoldings.id,
      name: schema.portfolioHoldings.name,
      symbol: schema.portfolioHoldings.symbol,
      currency: schema.portfolioHoldings.currency,
      accountName: schema.accounts.name,
    })
    .from(schema.portfolioHoldings)
    .leftJoin(schema.accounts, eq(schema.portfolioHoldings.accountId, schema.accounts.id))
    .where(eq(schema.portfolioHoldings.userId, userId))
    .all();

  // Get latest cached prices
  const prices = await db.select().from(schema.priceCache).where(eq(schema.priceCache.userId, userId)).all();
  const priceMap = new Map<string, number>();
  for (const p of prices) {
    const sym = String(p.symbol);
    const existing = priceMap.get(sym);
    if (!existing || String(p.date) > (prices.find((pp) => String(pp.symbol) === sym && Number(pp.price) === existing)?.date ?? "")) {
      priceMap.set(sym, Number(p.price));
    }
  }

  // Calculate current allocation
  const holdingsWithValue = holdings.map((h) => ({
    ...h,
    value: h.symbol ? priceMap.get(h.symbol) ?? 0 : 0,
  }));

  const totalValue = holdingsWithValue.reduce((s, h) => s + h.value, 0);

  // Compare with targets
  const comparison = targets.map((t) => {
    const matchingHoldings = holdingsWithValue.filter((h) => {
      const sym = String(h.symbol ?? "");
      if (t.category === "US" && (sym.includes("VUN") || sym === "VTI" || sym.includes("VUAA") || sym.includes("VUSD") || sym.includes("VNRA") || sym.includes("TPU"))) return true;
      if (t.category === "Canada" && sym.includes("VCN")) return true;
      if (t.category === "International" && (sym.includes("VIU") || sym.includes("VWRA") || sym.includes("VWRD") || sym.includes("VHVE") || sym.includes("TPE"))) return true;
      if (t.category === "Emerging" && (sym.includes("VFEA"))) return true;
      if (t.category === "Japan" && (sym.includes("VJP"))) return true;
      if (t.category === "Asia" && (sym.includes("VAPU"))) return true;
      if (t.category === "Crypto" && h.accountName === "WealthSImple") return true;
      return false;
    });

    const currentValue = matchingHoldings.reduce((s, h) => s + h.value, 0);
    const currentPct = totalValue > 0 ? (currentValue / totalValue) * 100 : 0;
    const drift = currentPct - t.targetPct;
    const targetValue = (t.targetPct / 100) * totalValue;
    const adjustmentNeeded = targetValue - currentValue;

    return {
      category: t.category,
      name: t.name,
      targetPct: t.targetPct,
      currentPct: Math.round(currentPct * 10) / 10,
      drift: Math.round(drift * 10) / 10,
      currentValue: Math.round(currentValue * 100) / 100,
      targetValue: Math.round(targetValue * 100) / 100,
      adjustmentNeeded: Math.round(adjustmentNeeded * 100) / 100,
      holdings: matchingHoldings.map((h) => h.name),
    };
  });

  return NextResponse.json({
    targets,
    comparison,
    totalValue: Math.round(totalValue * 100) / 100,
    needsRebalancing: comparison.some((c) => Math.abs(c.drift) > 5),
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  try {
    const body = await request.json();

    if (body.action === "set-targets") {
      // Replace all targets for this user
      await db.delete(schema.targetAllocations).where(eq(schema.targetAllocations.userId, userId));
      for (const t of body.targets) {
        await db.insert(schema.targetAllocations).values({
          userId,
          name: t.name,
          targetPct: t.targetPct,
          category: t.category,
        });
      }
      return NextResponse.json({ success: true });
    }

    const target = await db.insert(schema.targetAllocations).values({
      userId,
      name: body.name,
      targetPct: body.targetPct,
      category: body.category,
    }).returning().get();

    return NextResponse.json(target, { status: 201 });
  } catch (error: unknown) {
    const message = safeErrorMessage(error, "Rebalancing operation failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
