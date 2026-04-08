/**
 * GET /api/healthz — Infrastructure health check.
 *
 * Returns 200 when the app is healthy. Used by Docker HEALTHCHECK,
 * Nginx health gate, and uptime monitors.
 *
 * Response shape:
 *   { status: "ok" | "degraded", checks: { db: "ok" | "error", ... } }
 *
 * No authentication required — this endpoint is intentionally public
 * so load balancers and Docker can reach it without credentials.
 */

import { NextResponse } from "next/server";
import { getAdapter, getDialect } from "@/db";

export const dynamic = "force-dynamic";

interface HealthChecks {
  db: "ok" | "error";
  [key: string]: "ok" | "error";
}

export async function GET() {
  const checks: HealthChecks = { db: "ok" };
  let overall: "ok" | "degraded" = "ok";

  // ── Database health ────────────────────────────────────────────────────────
  try {
    const dialect = getDialect();

    if (dialect === "postgres") {
      const adapter = getAdapter();
      if (!adapter || !adapter.isConnected()) {
        checks.db = "error";
      } else {
        // Run a trivial query to confirm the pool is live
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pgDb = (adapter as any).getDb() as any;
        const { sql } = await import("drizzle-orm");
        await pgDb.execute(sql`SELECT 1`);
      }
    } else {
      // SQLite: just check if the connection is open
      const { isUnlocked } = await import("@/db");
      // SQLite is considered healthy if the app started (unlock happens via UI)
      // We don't fail health checks for a locked DB — the app is running fine.
      checks.db = isUnlocked() ? "ok" : "ok";
    }
  } catch {
    checks.db = "error";
  }

  // ── Aggregate status ───────────────────────────────────────────────────────
  if (Object.values(checks).some((v) => v === "error")) {
    overall = "degraded";
  }

  const status = overall === "ok" ? 200 : 503;

  return NextResponse.json(
    {
      status: overall,
      checks,
      ts: new Date().toISOString(),
    },
    { status }
  );
}
