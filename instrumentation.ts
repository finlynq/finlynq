/**
 * Next.js instrumentation hook — runs once when the server starts.
 *
 * Responsible for bootstrapping the PostgreSQL adapter when DATABASE_URL
 * is set (managed hosted edition). In self-hosted mode (no DATABASE_URL),
 * this is a no-op and the existing SQLite connection flow handles initialization.
 *
 * Docs: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  // Only runs in the Node.js runtime (not Edge), where native pg is available.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const databaseUrl = process.env.PF_DATABASE_URL || process.env.DATABASE_URL;
  if (!databaseUrl) {
    // Self-hosted mode — SQLite adapter is initialized on first unlock via the UI.
    return;
  }

  console.log("[instrumentation] DATABASE_URL detected — initializing PostgreSQL adapter");

  try {
    const { PostgresAdapter, setAdapter, setDialect } = await import("./src/db/index");

    const adapter = new PostgresAdapter();
    await adapter.initialize({
      dialect: "postgres",
      postgres: {
        connectionString: databaseUrl,
        userId: "", // userId is set per-request from the JWT; adapter stores pool only
        poolSize: parseInt(process.env.PG_POOL_SIZE ?? "10", 10),
      },
    });

    setAdapter(adapter);
    setDialect("postgres");

    console.log("[instrumentation] PostgreSQL adapter ready");

    // Kick off the MCP upload GC once the DB is ready. 30-minute interval.
    try {
      const { startUploadCleanupTimer, cleanupExpiredUploads } = await import(
        "./src/lib/mcp/upload-cleanup"
      );
      // Run one sweep at boot in case we restarted with a backlog.
      cleanupExpiredUploads().catch((err) => {
        console.error("[instrumentation] initial mcp-upload sweep failed:", err);
      });
      startUploadCleanupTimer();
    } catch (err) {
      console.error("[instrumentation] Failed to start mcp-upload cleanup:", err);
    }

    // Same pattern for email-import staging + admin inbox trash.
    try {
      const { startEmailCleanupTimer, cleanupExpiredEmailArtifacts } = await import(
        "./src/lib/email-import/cleanup"
      );
      cleanupExpiredEmailArtifacts().catch((err) => {
        console.error("[instrumentation] initial email-import sweep failed:", err);
      });
      startEmailCleanupTimer();
    } catch (err) {
      console.error("[instrumentation] Failed to start email-import cleanup:", err);
    }

    // Future-dated FX settlement. Daily sweep that re-locks the FX rate on
    // rows whose date has arrived but was forward-dated at entry. See
    // src/lib/cron/settle-future-fx.ts.
    try {
      const { startSettleFutureFxTimer, settleFutureFxRates } = await import(
        "./src/lib/cron/settle-future-fx"
      );
      settleFutureFxRates().catch((err) => {
        console.error("[instrumentation] initial settle-future-fx sweep failed:", err);
      });
      startSettleFutureFxTimer();
    } catch (err) {
      console.error("[instrumentation] Failed to start settle-future-fx cron:", err);
    }

    // MCP idempotency keys cleanup (issue #98). Daily sweep — delete rows
    // older than 72h from `mcp_idempotency_keys`. The replay lookup also
    // filters on freshness, so this is purely a table-growth bound.
    try {
      const { startMcpIdempotencySweepTimer, sweepMcpIdempotencyKeys } = await import(
        "./src/lib/cron/sweep-mcp-idempotency"
      );
      sweepMcpIdempotencyKeys().catch((err) => {
        console.error("[instrumentation] initial sweep-mcp-idempotency failed:", err);
      });
      startMcpIdempotencySweepTimer();
    } catch (err) {
      console.error("[instrumentation] Failed to start sweep-mcp-idempotency cron:", err);
    }

    // Revoked JWT jtis cleanup (B7, 2026-05-07). Daily sweep — delete rows
    // whose `expires_at` is past. Past exp the JWT signature validation
    // would already reject the token, so keeping the row in the denylist
    // is wasted space. The auth path's 30s in-process cache means this
    // sweep doesn't need to be more aggressive.
    try {
      const { startRevokedJtisSweepTimer, sweepRevokedJtis } = await import(
        "./src/lib/cron/sweep-revoked-jtis"
      );
      sweepRevokedJtis().catch((err) => {
        console.error("[instrumentation] initial sweep-revoked-jtis failed:", err);
      });
      startRevokedJtisSweepTimer();
    } catch (err) {
      console.error("[instrumentation] Failed to start sweep-revoked-jtis cron:", err);
    }
  } catch (err) {
    // Log but don't crash the server — healthz will report degraded state
    console.error("[instrumentation] Failed to initialize PostgreSQL adapter:", err);
  }
}
