/**
 * Next.js instrumentation — runs once when the server starts.
 *
 * Initializes the correct database adapter based on DATABASE_URL:
 * - If DATABASE_URL is set → PostgreSQL (managed mode)
 * - Otherwise → SQLite (self-hosted, initialized lazily via unlock)
 *
 * This is the ONLY instrumentation.ts in the project. Next.js resolves the
 * instrumentation hook relative to the configured source directory, and this
 * repo uses the `src/` layout (see tsconfig.json's `@/*` → `./src/*`), so a
 * root-level `instrumentation.ts` is never loaded — it used to exist
 * alongside this file and silently register a second, divergent set of
 * crons that never actually ran. Register every server-boot job HERE.
 */

export async function register() {
  // Only run on the server
  if (typeof window !== "undefined") return;

  const databaseUrl = process.env.PF_DATABASE_URL || process.env.DATABASE_URL;
  if (!databaseUrl) return; // SQLite mode — initialized on unlock

  const { PostgresAdapter } = await import("@/db/adapters/postgres");
  const { setAdapter, setDialect } = await import("@/db");

  const adapter = new PostgresAdapter();
  await adapter.initialize({
    dialect: "postgres",
    postgres: {
      connectionString: databaseUrl,
      userId: "", // Multi-tenant user scoping handled at query level
    },
  });

  setAdapter(adapter);
  setDialect("postgres");

  console.log("[instrumentation] PostgreSQL adapter initialized (managed mode)");

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

  // Email-import staging + admin inbox trash cleanup.
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

  // (No inbound-email poll cron.) Under the DevManager push relay
  // (INBOUND_EMAIL_PROVIDER=self-smtp) the app holds no Mailpit credentials
  // and never polls a mail store — DevManager owns retries via its own
  // reconciliation sweep (re-pushes any message we didn't 2xx). Resend
  // self-retries via svix. So there is nothing for the app to back-stop.

  // ─── Cron registration ──────────────────────────────────────────────────
  // Phase 3 of plan/portfolio-lots-and-performance.md — nightly snapshot
  // builder. Uses setInterval with a 24h period; first run fires 24h
  // after server start. For the proper 21:00-UTC schedule, a follow-up
  // can compute the delay to next 21:00 UTC and seed with setTimeout.
  try {
    const { runSnapshotsCron } = await import(
      "./lib/cron/portfolio-snapshots"
    );
    const ONE_DAY = 24 * 60 * 60 * 1000;
    const timer: NodeJS.Timeout = setInterval(() => {
      runSnapshotsCron().catch((err) => {

        console.error("[portfolio-snapshots-cron] run failed:", err);
      });
    }, ONE_DAY);
    if (timer.unref) timer.unref();
    console.log("[instrumentation] portfolio-snapshots cron registered (24h interval)");
  } catch (err) {

    console.error("[instrumentation] failed to register portfolio-snapshots cron:", err);
  }

  // Note: there is intentionally NO background snapshot-drain cron. Post Stream
  // D Phase 4 holding symbols are encrypted, so a DEK-less background job can't
  // price investment holdings (it would write $1/unit garbage and clobber good
  // snapshots). Auto-rebuild after a back-dated investment edit is instead a
  // DEK-bearing self-heal on chart load (src/app/api/net-worth-history) plus
  // the manual "Rebuild investment history" button. The portfolio_snapshot_dirty
  // marker is the work-list both consume. plan/net-worth-over-time.md Part B.
}
