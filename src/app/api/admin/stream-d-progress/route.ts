/**
 * GET /api/admin/stream-d-progress — Stream D backfill / null progress.
 *
 * Stream D Phase 4 (2026-05-03) physically dropped the plaintext columns,
 * so backfill (encrypt plaintext into `name_ct`) is no longer meaningful —
 * there is no plaintext source to read from. This endpoint now reports the
 * post-cutover state: how many rows are missing `name_ct` (which post-cutover
 * means a stdio-MCP-write-style row that bypassed encryption — should be 0
 * because stdio MCP create-paths now refuse those writes).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/require-admin";
import { db, schema } from "@/db";
import { isNull, sql } from "drizzle-orm";

const TABLES = [
  { name: "accounts", t: schema.accounts, ct: schema.accounts.nameCt },
  { name: "categories", t: schema.categories, ct: schema.categories.nameCt },
  { name: "goals", t: schema.goals, ct: schema.goals.nameCt },
  { name: "loans", t: schema.loans, ct: schema.loans.nameCt },
  { name: "subscriptions", t: schema.subscriptions, ct: schema.subscriptions.nameCt },
  { name: "portfolio_holdings", t: schema.portfolioHoldings, ct: schema.portfolioHoldings.nameCt },
] as const;

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.authenticated) return auth.response;

  const rows: { table: string; remaining: number; total: number }[] = [];
  for (const { name, t, ct } of TABLES) {
    const totalRow = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(t)
      .get();
    const remRow = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(t)
      .where(isNull(ct))
      .get();
    rows.push({
      table: name,
      total: totalRow?.c ?? 0,
      remaining: remRow?.c ?? 0,
    });
  }
  const remaining = rows.reduce((s, r) => s + r.remaining, 0);
  return NextResponse.json({
    complete: remaining === 0,
    totalRemaining: remaining,
    byTable: rows,
  });
}
