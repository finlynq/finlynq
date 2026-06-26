/**
 * Admin diagnostics log — /admin/diagnostics.
 *
 * GET    — newest-first rows from the persistent `diagnostics_log` table
 *          (slow queries, DB errors, API 5xx, outbound provider failures), with
 *          optional `kind` + `minMs` filters and a per-kind summary (total +
 *          last-24h). Unlike /admin/api-log this SURVIVES restarts.
 * DELETE — clear the table.
 *
 * Hand-rolls `requireAdmin` + the managed-mode postgres-dialect guard, mirroring
 * the other /api/admin/* routes. Read-only against a global table; no DEK.
 */

import { NextRequest, NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import { db, getDialect } from "@/db";
import { normalizeDbRows } from "@/lib/db-utils";
import { requireAdmin } from "@/lib/auth/require-admin";
import { SLOW_QUERY_MS, DIAGNOSTICS_CAP } from "@/lib/diagnostics/log";
import { getEnvName } from "@/lib/diagnostics/env";

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
function isoOf(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v ?? "");
}

const KINDS = new Set(["slow_query", "db_error", "api_error", "outbound_error"]);

export async function GET(request: NextRequest) {
  if (getDialect() !== "postgres") {
    return NextResponse.json(
      { error: "Admin features are only available in managed mode." },
      { status: 403 },
    );
  }
  const auth = await requireAdmin(request);
  if (!auth.authenticated) return auth.response;

  const sp = request.nextUrl.searchParams;
  const kind = sp.get("kind");
  const minMs = Number(sp.get("minMs"));
  const limit = Math.min(Math.max(Number(sp.get("limit")) || 200, 1), 1000);

  const conds: SQL[] = [];
  if (kind && KINDS.has(kind)) conds.push(sql`kind = ${kind}`);
  if (Number.isFinite(minMs) && minMs > 0) conds.push(sql`duration_ms >= ${Math.floor(minMs)}`);
  const where = conds.length ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``;

  const [rowsRes, summaryRes] = await Promise.all([
    db.execute(sql`
      SELECT id, at, kind, duration_ms, source, op, env, detail, message, code
      FROM diagnostics_log
      ${where}
      ORDER BY id DESC
      LIMIT ${limit}
    `),
    db.execute(sql`
      SELECT kind,
             count(*)::int AS total,
             count(*) FILTER (WHERE at > now() - interval '24 hours')::int AS last24h
      FROM diagnostics_log
      GROUP BY kind
    `),
  ]);

  const rows = normalizeDbRows(rowsRes).map((r) => ({
    id: num(r.id),
    at: isoOf(r.at),
    kind: (r.kind as string) ?? "",
    durationMs: r.duration_ms == null ? null : num(r.duration_ms),
    source: (r.source as string) ?? null,
    op: (r.op as string) ?? null,
    env: (r.env as string) ?? null,
    detail: (r.detail as string) ?? null,
    message: (r.message as string) ?? null,
    code: (r.code as string) ?? null,
  }));

  const summary = normalizeDbRows(summaryRes).map((r) => ({
    kind: (r.kind as string) ?? "",
    total: num(r.total),
    last24h: num(r.last24h),
  }));

  return NextResponse.json({
    rows,
    summary,
    meta: { slowQueryMs: SLOW_QUERY_MS, cap: DIAGNOSTICS_CAP, returned: rows.length, env: getEnvName() },
  });
}

export async function DELETE(request: NextRequest) {
  if (getDialect() !== "postgres") {
    return NextResponse.json(
      { error: "Admin features are only available in managed mode." },
      { status: 403 },
    );
  }
  const auth = await requireAdmin(request);
  if (!auth.authenticated) return auth.response;

  const countRes = await db.execute(sql`SELECT count(*)::int AS c FROM diagnostics_log`);
  const cleared = num(normalizeDbRows(countRes)[0]?.c);
  await db.execute(sql`DELETE FROM diagnostics_log`);
  return NextResponse.json({ cleared });
}
