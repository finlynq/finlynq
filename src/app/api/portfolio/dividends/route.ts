/**
 * Dividend-income endpoint — Phase 2 of plan/portfolio-lots-and-performance.md.
 *
 * GET /api/portfolio/dividends?from=&to=&taxYear=&holdingId=&accountId=&groupBy=&format=csv
 *
 * `groupBy ∈ {quarter, year, holding}` returns aggregated rows;
 * omit `groupBy` to get raw transaction rows. CSV stream when
 * `format=csv`.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { getDEK } from "@/lib/crypto/dek-cache";
import { getDisplayCurrency } from "@/lib/fx-service";
import { selfHealReportingAmounts } from "@/lib/fx/reporting-amount";
import {
  listDividendIncome,
  dividendsToCsv,
  type DividendIncomeFilter,
} from "@/lib/portfolio/dividends";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, sessionId } = auth.context;
  const dek = sessionId ? getDEK(sessionId, userId) : null;

  const params = request.nextUrl.searchParams;
  const groupByRaw = params.get("groupBy");
  // FINLYNQ-182 — opt-in reporting / native-pivot flags. Callers that omit
  // these (mobile, MCP) get the unchanged legacy native shape.
  const reportingMode =
    params.get("reportingCurrency") === "1" || params.get("reportingCurrency") === "true";
  const pivot = params.get("pivot") === "1" || params.get("pivot") === "true";
  const filter: DividendIncomeFilter = {
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
    taxYear: params.get("taxYear")
      ? parseInt(params.get("taxYear")!, 10)
      : undefined,
    holdingId: params.get("holdingId")
      ? parseInt(params.get("holdingId")!, 10)
      : undefined,
    accountId: params.get("accountId")
      ? parseInt(params.get("accountId")!, 10)
      : undefined,
    groupBy:
      groupByRaw === "quarter" || groupByRaw === "year" || groupByRaw === "holding"
        ? groupByRaw
        : undefined,
    reportingCurrency: reportingMode || undefined,
    pivot: pivot || undefined,
  };

  // FINLYNQ-182 — reporting mode reads the STORED historical reporting fields
  // (`reporting_amount`/`reporting_currency`); fire the background re-rate so
  // stale rows converge on the display currency (same fire-and-forget pattern
  // as the dashboard + flow reports). NEVER converts at render time.
  if (reportingMode) {
    const displayCurrency = await getDisplayCurrency(userId);
    void selfHealReportingAmounts(userId, displayCurrency);
  }

  const result = await listDividendIncome(userId, dek, filter);

  if (params.get("format") === "csv") {
    const csv = dividendsToCsv(result);
    const filenameParts: string[] = ["dividends"];
    if (filter.taxYear) filenameParts.push(String(filter.taxYear));
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filenameParts.join("-")}.csv"`,
      },
    });
  }

  return NextResponse.json({ success: true, data: result });
}
