import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateBody, safeErrorMessage } from "@/lib/validate";
import { requireAuth } from "@/lib/auth";
import {
  getEtfInfoAll,
  getEtfInfoBySymbol,
  seedEtfFromData,
  upsertEtfInfo,
  replaceEtfRegions,
  replaceEtfSectors,
  replaceEtfConstituents,
} from "@/db/etf-db";
import {
  getHardcodedEtfRegions,
  getHardcodedEtfSectors,
  getHardcodedEtfTopHoldings,
  getHardcodedEtfSymbols,
} from "@/lib/price-service";

// GET: list all ETFs in the shared ETF database (no unlock required — public data)
export async function GET() {
  const etfs = getEtfInfoAll();
  return NextResponse.json({ etfs, count: etfs.length });
}

// POST: seed or refresh ETF breakdown data (requires auth)
// body: { action: "seed" } — populate all from hardcoded data
// body: { action: "seed-symbol", symbol: "VUN.TO" } — seed one ETF from hardcoded
// body: { action: "refresh", symbol: "VUN.TO", regions: {...}, sectors: {...}, constituents: [...] } — update one ETF
export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  try {
    const body = await request.json();

    const etfActionSchema = z.object({
      action: z.string(),
    }).passthrough();
    const parsed = validateBody(body, etfActionSchema);
    if (parsed.error) return parsed.error;

    if (body.action === "seed") {
      return seedAllFromHardcoded();
    }

    if (body.action === "seed-symbol" && body.symbol) {
      return seedOneFromHardcoded(body.symbol);
    }

    if (body.action === "refresh" && body.symbol) {
      return refreshEtf(body);
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (error: unknown) {
    const message = safeErrorMessage(error, "ETF data operation failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function seedAllFromHardcoded() {
  const symbols = getHardcodedEtfSymbols();
  let seeded = 0;

  for (const symbol of symbols) {
    const regions = getHardcodedEtfRegions(symbol);
    const sectors = getHardcodedEtfSectors(symbol);
    const holdings = getHardcodedEtfTopHoldings(symbol);

    seedEtfFromData(
      symbol,
      holdings?.fullName ?? symbol,
      holdings?.totalHoldings ?? 0,
      regions,
      sectors,
      holdings?.constituents ?? null,
    );
    seeded++;
  }

  return NextResponse.json({ success: true, seeded, message: `Seeded ${seeded} ETFs from hardcoded data` });
}

function seedOneFromHardcoded(symbol: string) {
  const regions = getHardcodedEtfRegions(symbol);
  const sectors = getHardcodedEtfSectors(symbol);
  const holdings = getHardcodedEtfTopHoldings(symbol);

  if (!regions && !sectors && !holdings) {
    return NextResponse.json({ error: `No hardcoded data available for ${symbol}` }, { status: 404 });
  }

  seedEtfFromData(
    symbol,
    holdings?.fullName ?? symbol,
    holdings?.totalHoldings ?? 0,
    regions,
    sectors,
    holdings?.constituents ?? null,
  );

  return NextResponse.json({ success: true, symbol, message: `Seeded ${symbol} from hardcoded data` });
}

function refreshEtf(body: {
  symbol: string;
  fullName?: string;
  totalHoldings?: number;
  regions?: Record<string, number>;
  sectors?: Record<string, number>;
  constituents?: { ticker: string; name: string; weight: number; sector: string; country: string }[];
}) {
  const { symbol } = body;
  const existing = getEtfInfoBySymbol(symbol);

  upsertEtfInfo(
    symbol,
    body.fullName ?? existing?.full_name ?? symbol,
    body.totalHoldings ?? existing?.total_holdings ?? 0,
  );

  if (body.regions) {
    replaceEtfRegions(symbol, body.regions);
  }
  if (body.sectors) {
    replaceEtfSectors(symbol, body.sectors);
  }
  if (body.constituents) {
    replaceEtfConstituents(symbol, body.constituents);
  }

  return NextResponse.json({ success: true, symbol, message: `Refreshed ${symbol}` });
}
