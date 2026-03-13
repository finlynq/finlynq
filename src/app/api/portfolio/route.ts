import { NextResponse } from "next/server";
import { getPortfolioHoldings } from "@/lib/queries";

export async function GET() {
  const data = getPortfolioHoldings();
  return NextResponse.json(data);
}
