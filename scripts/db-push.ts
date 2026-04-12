/**
 * PostgreSQL schema push using Drizzle migrations.
 * Usage: DATABASE_URL="postgresql://..." npx tsx scripts/db-push.ts
 *
 * This runs Drizzle migrations against a PostgreSQL database.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Usage: DATABASE_URL="postgresql://..." npx tsx scripts/db-push.ts');
  process.exit(1);
}

console.log("Connecting to PostgreSQL database...");

const pool = new pg.Pool({ connectionString: databaseUrl });

// Validate connection
try {
  const client = await pool.connect();
  await client.query("SELECT 1");
  client.release();
  console.log("Database connection established.");
} catch (err) {
  console.error("ERROR: Could not connect to PostgreSQL database.");
  console.error(err);
  process.exit(1);
}

const db = drizzle(pool);

console.log("Running migrations from ./drizzle-pg...");

try {
  await migrate(db, { migrationsFolder: "./drizzle-pg" });
  console.log("Migrations applied successfully.");
} catch (error) {
  console.error("Migration failed:", error);
  process.exit(1);
} finally {
  await pool.end();
}
