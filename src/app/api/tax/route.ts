import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import {
  getTotalTFSARoom,
  getRRSPRoom,
  getRESPGrant,
  getAssetLocationAdvice,
  getMarginalRate,
  rrspVsTfsa,
} from "@/lib/tax-optimizer";
import { requireUnlock } from "@/lib/require-unlock";

export async function GET() {
  const locked = requireUnlock(); if (locked) return locked;
  // Get contribution room records
  const contributions = db.select().from(schema.contributionRoom).all();

  // Get holdings for asset location advice
  const holdings = db
    .select({
      name: schema.portfolioHoldings.name,
      symbol: schema.portfolioHoldings.symbol,
      accountName: schema.accounts.name,
      accountType: schema.accounts.type,
    })
    .from(schema.portfolioHoldings)
    .leftJoin(schema.accounts, eq(schema.portfolioHoldings.accountId, schema.accounts.id))
    .all();

  const advice = getAssetLocationAdvice(
    holdings.map((h) => ({
      name: h.name,
      symbol: h.symbol ?? "",
      accountName: h.accountName ?? "",
      accountType: h.accountType ?? "",
    }))
  );

  const currentYear = new Date().getFullYear();
  const tfsaTotalRoom = getTotalTFSARoom(2009, currentYear);

  // Calculate used TFSA room from contributions records
  const tfsaUsed = contributions
    .filter((c) => c.type === "TFSA")
    .reduce((s, c) => s + (c.used ?? 0), 0);

  const rrspContribs = contributions.filter((c) => c.type === "RRSP");
  const respContribs = contributions.filter((c) => c.type === "RESP");

  return NextResponse.json({
    tfsa: {
      totalRoom: tfsaTotalRoom,
      used: tfsaUsed,
      remaining: tfsaTotalRoom - tfsaUsed,
      currentYearLimit: 7000,
    },
    rrsp: {
      contributions: rrspContribs,
    },
    resp: {
      contributions: respContribs,
      grantExample: getRESPGrant(2500),
    },
    assetLocationAdvice: advice,
    marginalRates: {
      at50k: getMarginalRate(50000),
      at80k: getMarginalRate(80000),
      at100k: getMarginalRate(100000),
      at150k: getMarginalRate(150000),
    },
  });
}

export async function POST(request: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  try {
    const body = await request.json();

    if (body.action === "rrsp-vs-tfsa") {
      const result = rrspVsTfsa(body.income, body.contribution);
      return NextResponse.json(result);
    }

    // Save contribution room
    const record = db.insert(schema.contributionRoom).values({
      type: body.type,
      year: body.year,
      room: body.room,
      used: body.used ?? 0,
      note: body.note ?? "",
    }).returning().get();

    return NextResponse.json(record, { status: 201 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
