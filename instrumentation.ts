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
  } catch (err) {
    // Log but don't crash the server — healthz will report degraded state
    console.error("[instrumentation] Failed to initialize PostgreSQL adapter:", err);
  }
}
