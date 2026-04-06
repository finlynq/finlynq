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
}
