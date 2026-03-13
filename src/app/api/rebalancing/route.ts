import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";

export async function GET() {
  const targets = db.select().from(schema.targetAllocations).all();

  // Get portfolio holdings with cached prices
  const holdings = db
    .select({
      id: schema.portfolioHoldings.id,
      name: schema.portfolioHoldings.name,
      symbol: schema.portfolioHoldings.symbol,
      currency: schema.portfolioHoldings.currency,
      accountName: schema.accounts.name,
    })
    .from(schema.portfolioHoldings)
    .leftJoin(schema.accounts, eq(schema.portfolioHoldings.accountId, schema.accounts.id))
    .all();

  // Get latest cached prices
  const prices = db.select().from(schema.priceCache).all();
  const priceMap = new Map<string, number>();
  for (const p of prices) {
    const existing = priceMap.get(p.symbol);
    if (!existing || p.date > (prices.find((pp) => pp.symbol === p.symbol && pp.price === existing)?.date ?? "")) {
      priceMap.set(p.symbol, p.price);
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
      const sym = h.symbol ?? "";
      // Simple matching based on category name
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
  try {
    const body = await request.json();

    if (body.action === "set-targets") {
      // Replace all targets
      db.delete(schema.targetAllocations).run();
      for (const t of body.targets) {
        db.insert(schema.targetAllocations).values({
          name: t.name,
          targetPct: t.targetPct,
          category: t.category,
        }).run();
      }
      return NextResponse.json({ success: true });
    }

    const target = db.insert(schema.targetAllocations).values({
      name: body.name,
      targetPct: body.targetPct,
      category: body.category,
    }).returning().get();

    return NextResponse.json(target, { status: 201 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
