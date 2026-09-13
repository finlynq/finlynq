/**
 * Next.js instrumentation — runs once when the server starts.
 *
 * Initializes the correct database adapter based on DATABASE_URL:
 * - If DATABASE_URL is set → PostgreSQL (managed mode)
 * - Otherwise → SQLite (self-hosted, initialized lazily via unlock)
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

  // ─── Cron registration ──────────────────────────────────────────────────
  // Phase 3 of plan/portfolio-lots-and-performance.md — nightly snapshot
  // builder. Uses setInterval with a 24h period; first run fires 24h
  // after server start. For the proper 21:00-UTC schedule, a follow-up
  // can compute the delay to next 21:00 UTC and seed with setTimeout.
  //
  // Note: the older crons (settle-future-fx, sweep-mcp-idempotency,
  // sweep-revoked-jtis) export startSettleFutureFxTimer() etc. but
  // aren't currently invoked from anywhere — a pre-existing latent
  // issue separate from this phase. Fixing them is out of scope here.
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
