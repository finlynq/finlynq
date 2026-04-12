/**
 * PostgreSQL Drizzle schema push.
 * Usage: DATABASE_URL="postgresql://..." npx tsx scripts/db-push.ts
 *
 * This runs Drizzle migrations against PostgreSQL database.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("Usage: DATABASE_URL=\\"postgresql://...\\" npx tsx scripts/db-push.ts");
  process.exit(1);
}

console.log("Connecting to PostgreSQL database...");

const pool = new Pool({
  connectionString: databaseUrl,
});

// Validate connection
try {
  const client = await pool.connect();
  await client.query("SELECT 1");
  client.release();
  console.log("Database connection verified.");
} catch (error) {
  console.error("ERROR: Could not connect to PostgreSQL database:", error);
  process.exit(1);
}

const db = drizzle(pool);

console.log("Running migrations from ./drizzle...");

try {
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations applied successfully.");
} catch (error) {
  console.error("Migration failed:", error);
  process.exit(1);
} finally {
  await pool.end();
}
