import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, and } from "drizzle-orm";
import {
  getTotalTFSARoom,
  getRRSPRoom,
  getRESPGrant,
  getAssetLocationAdvice,
  getMarginalRate,
  rrspVsTfsa,
} from "@/lib/tax-optimizer";
import { requireAuth } from "@/lib/auth/require-auth";
import { requireDevMode } from "@/lib/require-dev-mode";
import { safeErrorMessage } from "@/lib/validate";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const devGuard = await requireDevMode(request); if (devGuard) return devGuard;
  const { userId } = auth.context;
  // Get contribution room records
  const contributions = db.select().from(schema.contributionRoom).where(eq(schema.contributionRoom.userId, userId)).all();

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
    .where(eq(schema.portfolioHoldings.userId, userId))
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
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const devGuard = await requireDevMode(request); if (devGuard) return devGuard;
  const { userId } = auth.context;
  try {
    const body = await request.json();

    if (body.action === "rrsp-vs-tfsa") {
      const result = rrspVsTfsa(body.income, body.contribution);
      return NextResponse.json(result);
    }

    // Save contribution room
    const record = db.insert(schema.contributionRoom).values({
      userId,
      type: body.type,
      year: body.year,
      room: body.room,
      used: body.used ?? 0,
      note: body.note ?? "",
    }).returning().get();

    return NextResponse.json(record, { status: 201 });
  } catch (error: unknown) {
    const message = safeErrorMessage(error, "Tax operation failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
