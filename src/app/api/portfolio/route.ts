import { NextResponse } from "next/server";
import { getPortfolioHoldings } from "@/lib/queries";
import { requireUnlock } from "@/lib/require-unlock";

export async function GET() {
  const locked = requireUnlock(); if (locked) return locked;
  const data = getPortfolioHoldings();
  return NextResponse.json(data);
}
