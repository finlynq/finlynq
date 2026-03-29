import { NextRequest, NextResponse } from "next/server";
import { getPortfolioHoldings } from "@/lib/queries";
import { requireAuth } from "@/lib/auth/require-auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const data = getPortfolioHoldings(auth.context.userId);
  return NextResponse.json(data);
}
