#!/usr/bin/env node
/**
 * Schema migration runner (GH #312 / FINLYNQ-293).
 *
 * Used by the Docker entrypoint. Deliberately mirrors the migration section of
 * deploy.sh (`==> Running schema migrations...`) statement for statement — same
 * ledger, same ordering rule, same transaction boundary, same filename gate. If
 * you change one, change the other; `tests/migration-runner.test.ts` asserts the
 * two agree on the ordered version list.
 *
 * WHY THIS ISN'T DRIZZLE
 * The entrypoint used to `require('drizzle-orm/node-postgres')`, but Next's
 * standalone output compiles drizzle-orm INTO the server bundle rather than
 * emitting it as a resolvable package, so the require could never succeed in the
 * published image and `set -e` killed the container before `node server.js`.
 * `pg` IS resolvable (it's in `serverExternalPackages`), so this runner uses
 * nothing else. Do not reintroduce a drizzle import here.
 *
 * ORDER OF OPERATIONS
 *   1. ensure `schema_migrations` exists
 *   2. if the database is EMPTY, apply scripts/baseline/0001_schema_baseline.sql
 *      (which also records the migrations it subsumes)
 *   3. apply every scripts/migrations/*.sql not yet in the ledger, in filename
 *      order, each in its own transaction together with its ledger INSERT
 *
 * Step 2 is what makes a from-zero install possible at all. Replaying the
 * migration chain against an empty database does NOT work — measured 2026-07-24:
 * 38 of 70 files fail, 43 of 70 tables created. See the baseline file's header.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, "migrations");
const BASELINE_FILE = path.join(HERE, "baseline", "0001_schema_baseline.sql");

// Same gate as deploy.sh. It is the sole barrier against SQL injection via a
// hostile migration filename, because the ledger INSERT interpolates the version
// directly. Permits no quote, semicolon, backslash, or whitespace.
const SAFE_VERSION = /^[A-Za-z0-9_-]+$/;

const log = (msg) => console.log(`[migrate] ${msg}`);

function migrationFiles() {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  // Plain lexicographic sort — matches the shell glob expansion in deploy.sh.
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ version: path.basename(f, ".sql"), file: path.join(MIGRATIONS_DIR, f) }));
}

/**
 * A database is "fresh" when it holds no ordinary tables other than the ledger
 * itself. Anything else — a half-migrated database, a partial restore — is
 * ambiguous, and we refuse rather than guess: applying the baseline over a
 * partial schema would fail messily halfway through.
 */
async function classifyDatabase(client) {
  const { rows } = await client.query(`
    SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'
  `);
  if (rows.length === 0) return { fresh: true };
  const hasUsers = rows.some((r) => r.relname === "users");
  return { fresh: false, established: hasUsers, tableCount: rows.length };
}

async function applyBaseline(client) {
  if (!existsSync(BASELINE_FILE)) {
    throw new Error(
      `empty database but no baseline at ${BASELINE_FILE}. The migration chain ` +
        `alone CANNOT build the schema from zero — refusing to create a partial database.`,
    );
  }
  log("empty database detected — applying schema baseline");
  const sql = readFileSync(BASELINE_FILE, "utf8");
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
  const { rows } = await client.query("SELECT count(*)::int AS n FROM schema_migrations");
  log(`baseline applied — ${rows[0].n} migration(s) recorded as subsumed`);
}

async function main() {
  const connectionString = process.env.DATABASE_URL || process.env.PF_DATABASE_URL;
  if (!connectionString) {
    console.error("[migrate] ERROR: DATABASE_URL is required.");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const state = await classifyDatabase(client);
    if (state.fresh) {
      await applyBaseline(client);
    } else if (!state.established) {
      throw new Error(
        `database holds ${state.tableCount} table(s) but no "users" table — this looks ` +
          `like a partially-created schema. Refusing to apply the baseline over it. ` +
          `Start from an empty database, or restore from a pg_dump.`,
      );
    }

    const applied = new Set(
      (await client.query("SELECT version FROM schema_migrations")).rows.map((r) => r.version),
    );

    let count = 0;
    for (const { version, file } of migrationFiles()) {
      if (!SAFE_VERSION.test(version)) {
        throw new Error(
          `migration filename '${version}' contains unsafe characters; rename to [A-Za-z0-9_-] only.`,
        );
      }
      if (applied.has(version)) continue;

      log(`applying ${version}`);
      const sql = readFileSync(file, "utf8");
      // File body + ledger INSERT in ONE transaction, so a partial failure rolls
      // back cleanly and the next run retries. Migration files must not contain
      // their own BEGIN/COMMIT — an inner COMMIT would close this transaction
      // early and decouple the bookkeeping from the schema change.
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
        await client.query("COMMIT");
        count += 1;
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${version} failed: ${err.message}`);
      }
    }

    log(count === 0 ? "no new migrations to apply." : `applied ${count} migration(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`[migrate] ERROR: ${err.message}`);
  process.exit(1);
});
