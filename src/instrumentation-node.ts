/**
 * Node.js-runtime server boot — imported ONLY from src/instrumentation.ts,
 * inside its NEXT_RUNTIME === "nodejs" branch. Never import this module from
 * anywhere else: it pulls in pg and other Node-only modules that crash the
 * edge runtime.
 *
 * Bootstraps the PostgreSQL adapter when DATABASE_URL is set (managed hosted
 * edition) and registers every background job. In self-hosted mode (no
 * DATABASE_URL) it is a no-op and the SQLite flow initializes on first unlock.
 */

export async function registerNodeJobs(): Promise<void> {
  const databaseUrl = process.env.PF_DATABASE_URL || process.env.DATABASE_URL;
  if (!databaseUrl) {
    // Self-hosted mode — SQLite adapter is initialized on first unlock via the UI.
    return;
  }

  console.log("[instrumentation] DATABASE_URL detected — initializing PostgreSQL adapter");

  try {
    const { PostgresAdapter, setAdapter, setDialect } = await import("./db/index");

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

    // Start the durable system-metrics sampler at boot so /admin/system has a
    // continuous 24h CPU/load/mem history (not only after an admin first opens
    // the page). In-memory + ~1/min DB persist; cleared on restart but the DB
    // rows persist. Best-effort — never block startup.
    try {
      const { startSystemMetricsSampler } = await import("./lib/admin/system-metrics");
      startSystemMetricsSampler();
    } catch (err) {
      console.error("[instrumentation] Failed to start system-metrics sampler:", err);
    }

    // (The legacy mcp_uploads GC cron was removed with the mcp_uploads table —
    // every MCP statement import now runs through the staging pipeline.)

    // Same pattern for email-import staging + admin inbox trash.
    try {
      const { startEmailCleanupTimer, cleanupExpiredEmailArtifacts } = await import(
        "./lib/email-import/cleanup"
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
        "./lib/cron/settle-future-fx"
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
        "./lib/cron/sweep-mcp-idempotency"
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
        "./lib/cron/sweep-revoked-jtis"
      );
      sweepRevokedJtis().catch((err) => {
        console.error("[instrumentation] initial sweep-revoked-jtis failed:", err);
      });
      startRevokedJtisSweepTimer();
    } catch (err) {
      console.error("[instrumentation] Failed to start sweep-revoked-jtis cron:", err);
    }

    // Inactive DCR client expiry (FINLYNQ-160, audit #284 / M7). Daily sweep —
    // delete `oauth_clients` rows with no token activity for 60 days AND no
    // live (non-revoked, unexpired) tokens. Open DCR (RFC 7591) lets anyone
    // register a client; this bounds table growth and reaps abandoned /
    // leftover test clients once their tokens lapse. DEK-free hard delete.
    try {
      const { startExpireDcrClientsTimer, expireInactiveDcrClients } = await import(
        "./lib/cron/expire-dcr-clients"
      );
      expireInactiveDcrClients().catch((err) => {
        console.error("[instrumentation] initial expire-dcr-clients sweep failed:", err);
      });
      startExpireDcrClientsTimer();
    } catch (err) {
      console.error("[instrumentation] Failed to start expire-dcr-clients cron:", err);
    }

    // Nightly portfolio snapshots (plan/portfolio-lots-and-performance.md
    // Phase 3). Registered only in the old unloaded src hook before PR #346,
    // so it had never run. 24h setInterval; the first run fires 24h after
    // boot. The investment pass is inert without a DEK (buildDailySnapshot
    // no-ops); the cash pass is DEK-free real work — rolls today's cash
    // snapshot forward and refreshes a stale recent window. There is
    // intentionally NO background snapshot-DRAIN cron: back-dated investment
    // edits are rebuilt by the DEK-bearing chart-load self-heal + the manual
    // rebuild button.
    try {
      const { runSnapshotsCron } = await import("./lib/cron/portfolio-snapshots");
      const ONE_DAY = 24 * 60 * 60 * 1000;
      const timer: NodeJS.Timeout = setInterval(() => {
        runSnapshotsCron().catch((err) => {
          console.error("[portfolio-snapshots-cron] run failed:", err);
        });
      }, ONE_DAY);
      if (timer.unref) timer.unref();
      console.log("[instrumentation] portfolio-snapshots cron registered (24h interval)");
    } catch (err) {
      console.error("[instrumentation] Failed to register portfolio-snapshots cron:", err);
    }

    // (No inbound-email poll cron.) Under the DevManager push relay
    // (INBOUND_EMAIL_PROVIDER=self-smtp) the app holds no Mailpit credentials
    // and never polls a mail store — DevManager owns retries via its own
    // reconciliation sweep (re-pushes any message we didn't 2xx). Resend
    // self-retries via svix. So there is nothing for the app to back-stop.
  } catch (err) {
    // Log but don't crash the server — healthz will report degraded state
    console.error("[instrumentation] Failed to initialize PostgreSQL adapter:", err);
  }
}
