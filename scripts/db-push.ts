/**
 * Encrypted-aware Drizzle schema push.
 * Usage: PF_PASSPHRASE="your-passphrase" npx tsx scripts/db-push.ts
 *
 * This replaces `drizzle-kit push` for encrypted databases.
 * It opens the encrypted DB, then runs Drizzle migrations programmatically.
 */

import Database from "better-sqlite3-multiple-ciphers";
import type BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { deriveKey } from "../shared/crypto";
import { readConfig, resolveDbPath } from "../shared/config";

const passphrase = process.env.PF_PASSPHRASE;
if (!passphrase) {
  console.error("Usage: PF_PASSPHRASE=\"your-passphrase\" npx tsx scripts/db-push.ts");
  process.exit(1);
}

const config = readConfig();
const dbPath = resolveDbPath(config);

if (!config.salt) {
  console.error("No salt found in pf-config.json. Run the app setup wizard first.");
  process.exit(1);
}

const salt = Buffer.from(config.salt, "hex");
const hexKey = deriveKey(passphrase, salt);

console.log(`Opening encrypted database at: ${dbPath}`);

const sqlite = new (Database as unknown as typeof BetterSqlite3)(dbPath);
sqlite.pragma(`key = "x'${hexKey}'"`);

// Validate
try {
  sqlite.prepare("SELECT count(*) FROM sqlite_master").get();
  console.log("Database unlocked successfully.");
} catch {
  console.error("ERROR: Invalid passphrase. Could not unlock the database.");
  process.exit(1);
}

sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

const db = drizzle(sqlite);

console.log("Running migrations from ./drizzle...");

try {
  migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations applied successfully.");
} catch (error) {
  console.error("Migration failed:", error);
  process.exit(1);
} finally {
  sqlite.close();
}
