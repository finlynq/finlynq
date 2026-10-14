/**
 * Portfolio-performance endpoint — Phase 3 of plan/portfolio-lots-and-performance.md.
 *
 * GET /api/portfolio/performance?period=1m|3m|6m|ytd|1y|all&accountId=…
 *
 * Returns the daily value series + TWRR + MWRR for the period, computed by
 * the shared `computePortfolioReturns` (lib/portfolio/performance/returns.ts),
 * which MCP `get_portfolio_returns` also calls. New money (deposits,
 * withdrawals, transfers, plan contributions booked as reinvested income…)
 * is stripped out of both returns there — see external-flows.ts.
 *
 * The chart on /portfolio consumes this.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { computePortfolioReturns, type ReturnsPeriod } from "@/lib/portfolio/performance/returns";

const PERIODS: ReturnsPeriod[] = ["1m", "3m", "6m", "ytd", "1y", "all"];

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, dek } = auth.context;

  const params = request.nextUrl.searchParams;
  const requested = params.get("period") ?? "1y";
  const period: ReturnsPeriod = (PERIODS as string[]).includes(requested) ? (requested as ReturnsPeriod) : "1y";
  const accountId = params.get("accountId") ? parseInt(params.get("accountId")!, 10) : null;

  const data = await computePortfolioReturns({
    userId,
    dek: dek ?? null,
    period,
    accountId: accountId != null && Number.isFinite(accountId) ? accountId : null,
  });
  return NextResponse.json({ success: true, data });
}
