/**
 * Static parity gate: every index the MIGRATION chain creates must also be
 * declared in `src/db/schema-pg.ts`.
 *
 * WHY THIS EXISTS
 * ---------------
 * There are two ways a Finlynq database gets its schema:
 *
 *   1. `npm run db:migrate` / `deploy.sh` / the Docker entrypoint — baseline
 *      (`scripts/baseline/0001_schema_baseline.sql`) then every migration in
 *      `scripts/migrations/` that the baseline does not subsume. This is the
 *      documented from-zero path and what prod and dev actually run.
 *   2. `drizzle-kit push` from `src/db/schema-pg.ts` — what `npm run db:push`
 *      does, what our getting-started docs told self-hosters to run until
 *      2026-09-16, and what `.github/workflows/ci.yml` still uses to build the
 *      scratch database for the real-Postgres tests.
 *
 * Path 2 only ever creates what `schema-pg.ts` DECLARES. Historically the
 * migrations were the source of truth and `schema-pg.ts` was only kept
 * type-accurate, so it accumulated columns without their indexes. Measured
 * 2026-09-17 by building one database each way and diffing `pg_indexes`:
 * 94 index shapes existed on the migrate-built database and not on the
 * push-built one.
 *
 * That is not a performance footnote. A missing UNIQUE index silently breaks
 * every `INSERT ... ON CONFLICT (<those columns>)`, which Postgres rejects
 * with 42P10 "no unique or exclusion constraint matching the ON CONFLICT
 * specification" — and our upsert callsites routinely sit inside a try/catch
 * or a `.catch(() => {})`, so the write just does not happen and nothing is
 * reported. Two real instances:
 *
 *   - GH #348: `uq_bank_tx_hash` / `uq_bank_tx_fit` missing, so every
 *     statement promote wrote zero `bank_transactions` rows.
 *   - GH #352: `portfolio_snapshots_user_date_acct_idx` missing, so net-worth
 *     snapshots never persisted.
 *
 * Both were reported by an external self-hoster who had followed our own
 * install instructions.
 *
 * WHAT THIS CHECKS
 * ----------------
 * It is PURE — it parses SQL and TypeScript as text. No database, no mocks.
 * It reconstructs the set of index names the migration chain ends up with
 * (baseline, then `CREATE INDEX` / `DROP INDEX` in the post-baseline
 * migrations, in filename order) and asserts that each one is declared in
 * `schema-pg.ts` as `index("<name>")` or `uniqueIndex("<name>")`, with
 * matching uniqueness. It also checks the reverse direction, so a declaration
 * with a typo'd or invented name fails too.
 *
 * It deliberately does NOT compare column lists, sort direction or partial
 * predicates — text parsing cannot do that faithfully, and the DB-level diff
 * that can is a manual verification step (build both databases, diff
 * `pg_indexes`). Name + uniqueness catches the failure mode that bit us.
 *
 * WHEN THIS FAILS
 * ---------------
 * You added a migration that creates an index without declaring it in
 * `schema-pg.ts`. Add it in the SAME commit — that is the invariant.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..");
const BASELINE = path.join(ROOT, "scripts/baseline/0001_schema_baseline.sql");
const MIGRATIONS_DIR = path.join(ROOT, "scripts/migrations");
const SCHEMA_FILE = path.join(ROOT, "src/db/schema-pg.ts");

/**
 * Index names the migration chain creates that `schema-pg.ts` is NOT expected
 * to declare. Each entry needs a reason.
 *
 * Note that `pg_dump` emits constraint-backed indexes (`*_pkey`, `*_key`) as
 * `ALTER TABLE ... ADD CONSTRAINT`, never as `CREATE INDEX`, so the ones
 * Drizzle generates implicitly from `.primaryKey()` / `primaryKey()` /
 * `.unique()` / `unique()` never reach this scan and need no exemption. This
 * list exists for a hand-written migration that creates a backing index
 * directly.
 */
const EXEMPT: Record<string, string> = {};

type SqlIndex = { name: string; unique: boolean; table: string; source: string };

/** Every `CREATE [UNIQUE] INDEX` in one SQL file, in order. */
function parseCreateIndexes(sql: string, source: string): SqlIndex[] {
  const re =
    /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)\s+ON\s+(?:ONLY\s+)?(?:public\.)?([a-zA-Z0-9_]+)/gi;
  const out: SqlIndex[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    out.push({ unique: !!m[1], name: m[2], table: m[3], source });
  }
  return out;
}

/** Every `DROP INDEX` in one SQL file. */
function parseDropIndexes(sql: string): string[] {
  const re =
    /DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(?:public\.)?([a-zA-Z0-9_]+)/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) out.push(m[1]);
  return out;
}

/**
 * The migrations the baseline already contains. The baseline ends by
 * INSERTing their versions into `schema_migrations` so the runner skips them;
 * we read that same list rather than hardcoding a date cutoff, so this stays
 * correct if the baseline is ever regenerated.
 */
function subsumedMigrations(baselineSql: string): Set<string> {
  const marker = baselineSql.indexOf("Migrations subsumed by this baseline");
  expect(
    marker,
    "baseline must still carry its 'Migrations subsumed by this baseline' block",
  ).toBeGreaterThan(-1);
  const tail = baselineSql.slice(marker);
  return new Set([...tail.matchAll(/\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]));
}

/** Index names the migration chain leaves behind, and their uniqueness. */
function indexesFromMigrationChain(): Map<string, SqlIndex> {
  const baselineSql = readFileSync(BASELINE, "utf8");
  const subsumed = subsumedMigrations(baselineSql);

  const live = new Map<string, SqlIndex>();
  for (const idx of parseCreateIndexes(baselineSql, "baseline")) live.set(idx.name, idx);

  const postBaseline = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => !subsumed.has(f.replace(/\.sql$/, "")))
    .sort();

  for (const file of postBaseline) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    for (const idx of parseCreateIndexes(sql, file)) live.set(idx.name, idx);
    for (const dropped of parseDropIndexes(sql)) live.delete(dropped);
  }
  return live;
}

/** Index names declared in schema-pg.ts, and whether they are unique. */
function indexesDeclaredInSchema(): Map<string, boolean> {
  const src = readFileSync(SCHEMA_FILE, "utf8");
  const out = new Map<string, boolean>();
  for (const m of src.matchAll(/\b(uniqueIndex|index)\(\s*"([^"]+)"\s*\)/g)) {
    out.set(m[2], m[1] === "uniqueIndex");
  }
  return out;
}

describe("schema-pg.ts declares every index the migration chain creates", () => {
  const fromSql = indexesFromMigrationChain();
  const declared = indexesDeclaredInSchema();

  it("parses a plausible number of indexes from both sides (parser sanity)", () => {
    // If either parser silently stops matching, every other assertion in this
    // file passes vacuously. These floors are deliberately loose.
    expect(fromSql.size).toBeGreaterThan(100);
    expect(declared.size).toBeGreaterThan(100);
  });

  it("declares every migration-chain index", () => {
    const missing = [...fromSql.values()]
      .filter((i) => !(i.name in EXEMPT))
      .filter((i) => !declared.has(i.name))
      .map((i) => `${i.name} (${i.unique ? "UNIQUE " : ""}on ${i.table}, from ${i.source})`)
      .sort();

    expect(
      missing,
      `These indexes exist on a \`npm run db:migrate\` database but are NOT declared in ` +
        `src/db/schema-pg.ts, so a \`db:push\` install (and CI's scratch DB) will not have ` +
        `them. Add each one to its pgTable's third argument in the same commit as the ` +
        `migration. A missing UNIQUE index silently breaks ON CONFLICT with 42P10.`,
    ).toEqual([]);
  });

  it("declares each index with the same uniqueness as the migration chain", () => {
    const mismatched = [...fromSql.values()]
      .filter((i) => declared.has(i.name))
      .filter((i) => declared.get(i.name) !== i.unique)
      .map(
        (i) =>
          `${i.name}: SQL says ${i.unique ? "UNIQUE" : "non-unique"}, ` +
          `schema-pg.ts declares ${declared.get(i.name) ? "uniqueIndex" : "index"}`,
      )
      .sort();

    expect(mismatched, "uniqueness must match — it is a data-integrity guarantee").toEqual(
      [],
    );
  });

  it("does not declare indexes the migration chain never creates", () => {
    // Catches a typo'd name (which would leave BOTH the real index undeclared
    // and a phantom one declared) and a declaration that outlived its
    // migration.
    const phantom = [...declared.keys()].filter((n) => !fromSql.has(n)).sort();

    expect(
      phantom,
      `Declared in src/db/schema-pg.ts but created by no baseline/migration SQL. Either ` +
        `the name is a typo, or the index needs a migration so existing databases get it.`,
    ).toEqual([]);
  });

  it("keeps every EXEMPT entry justified and still real", () => {
    for (const [name, reason] of Object.entries(EXEMPT)) {
      expect(reason.length, `EXEMPT["${name}"] needs a reason`).toBeGreaterThan(20);
      expect(fromSql.has(name), `EXEMPT["${name}"] is stale — no SQL creates it`).toBe(true);
    }
  });
});
