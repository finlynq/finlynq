/**
 * Static parity gate: every CHECK constraint the MIGRATION chain produces must
 * also be declared in `src/db/schema-pg.ts`, with the same name AND — for the
 * enumerated ones — the same set of allowed values.
 *
 * WHY THIS EXISTS
 * ---------------
 * Sibling of `tests/schema-index-parity.test.ts`, which covers indexes. Same
 * root cause, different constraint kind: a database built with `drizzle-kit
 * push` contains only what `schema-pg.ts` DECLARES, and until 2026-09-17 that
 * file declared **zero** CHECK constraints while the real schema had 53. A
 * push-built install therefore accepted writes Postgres is supposed to reject,
 * silently — wrong `source` values, out-of-vocabulary `kind`s, negative
 * quantities on a lot.
 *
 * That is not hypothetical. PR #349's first revision wrote
 * `source: "auto_uncategorized"` into `transactions`, a value
 * `transactions_source_check` does not allow. On a correctly-built database
 * every insert raises 23514 and a per-row `try/catch` swallows it, so the
 * function reports success and materializes nothing. It looked fine in
 * development only because that database had been built with `db:push` and had
 * no CHECK constraints at all.
 *
 * WHAT THIS CHECKS
 * ----------------
 * PURE — it parses SQL and TypeScript as text. No database, no mocks.
 *
 *   1. Reconstructs the CHECK constraints the chain ends up with: the baseline
 *      (a `pg_dump`, so every constraint there is explicitly named), then
 *      `ADD CONSTRAINT … CHECK` / `DROP CONSTRAINT` in the post-baseline
 *      migrations, in filename order — so a later redefinition of the same
 *      name wins, exactly as it does when the runner applies them.
 *   2. Asserts each name is declared in `schema-pg.ts` as `check("<name>", …)`,
 *      and that nothing is declared which no SQL creates.
 *   3. For constraints of the enumerated form — `x = ANY (ARRAY[…])` in the
 *      dump, `x IN (…)` in the TypeScript, which Postgres parses to the same
 *      thing — compares the VALUE SET. This is the assertion that earns the
 *      file: a name-only check would pass while `transactions_source_check`
 *      declared nine of its ten sources, which is precisely the drift that
 *      produced the #349 bug.
 *   4. Asserts `SOURCES` in `src/lib/tx-source.ts` equals
 *      `transactions_source_check`'s value set. Those two have to agree or the
 *      application's own allow-list disagrees with the database's.
 *
 * It deliberately does NOT compare non-enumerated predicates as text
 * (`qty_remaining >= 0 AND qty_remaining <= qty_original` vs the dump's
 * `(qty_remaining >= (0)::double precision) AND …`). Text comparison there
 * reports parenthesisation and casts as failures; the real comparison is the
 * DB-level one — build a database each way and diff `pg_get_constraintdef` —
 * which is a manual verification step, done for this change on 2026-09-17.
 *
 * WHEN THIS FAILS
 * ---------------
 * You added or changed a CHECK in a migration without mirroring it in
 * `schema-pg.ts`. Do both in the same commit — that is the invariant.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..");
const BASELINE = path.join(ROOT, "scripts/baseline/0001_schema_baseline.sql");
const MIGRATIONS_DIR = path.join(ROOT, "scripts/migrations");
const SCHEMA_FILE = path.join(ROOT, "src/db/schema-pg.ts");
const TX_SOURCE_FILE = path.join(ROOT, "src/lib/tx-source.ts");

/**
 * CHECK names the chain creates that `schema-pg.ts` is NOT expected to declare.
 * Each entry needs a reason. Empty today.
 */
const EXEMPT: Record<string, string> = {};

type SqlCheck = { name: string; body: string; source: string };

/**
 * Read a balanced parenthesised expression starting at the `(` at `from`.
 * CHECK bodies nest several levels deep, so a non-greedy regex cannot do this.
 */
function balanced(sql: string, from: number): string {
  let depth = 0;
  let inString = false;
  for (let i = from; i < sql.length; i++) {
    const ch = sql[i];
    if (inString) {
      if (ch === "'") inString = sql[i + 1] === "'" ? (i++, true) : false;
      continue;
    }
    if (ch === "'") inString = true;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return sql.slice(from, i + 1);
    }
  }
  return "";
}

/**
 * Every named CHECK in one SQL file. Covers both spellings the chain uses:
 * the baseline's inline `CONSTRAINT <name> CHECK (…)` inside CREATE TABLE, and
 * a migration's `ADD CONSTRAINT <name> CHECK (…)`.
 */
function parseChecks(sql: string, source: string): SqlCheck[] {
  const re = /\bCONSTRAINT\s+([a-zA-Z0-9_]+)\s+CHECK\s*\(/gi;
  const out: SqlCheck[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const body = balanced(sql, re.lastIndex - 1);
    if (body) out.push({ name: m[1], body, source });
  }
  return out;
}

function parseDropConstraints(sql: string): string[] {
  const re = /DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?([a-zA-Z0-9_]+)/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) out.push(m[1]);
  return out;
}

/** Same subsumed-migration list the index-parity gate and the runner use. */
function subsumedMigrations(baselineSql: string): Set<string> {
  const marker = baselineSql.indexOf("Migrations subsumed by this baseline");
  expect(
    marker,
    "baseline must still carry its 'Migrations subsumed by this baseline' block",
  ).toBeGreaterThan(-1);
  return new Set(
    [...baselineSql.slice(marker).matchAll(/\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]),
  );
}

function checksFromMigrationChain(): Map<string, SqlCheck> {
  const baselineSql = readFileSync(BASELINE, "utf8");
  const subsumed = subsumedMigrations(baselineSql);

  const live = new Map<string, SqlCheck>();
  for (const c of parseChecks(baselineSql, "baseline")) live.set(c.name, c);

  const postBaseline = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => !subsumed.has(f.replace(/\.sql$/, "")))
    .sort();

  for (const file of postBaseline) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    // Drop first: a migration that redefines a constraint drops it and re-adds
    // it in the same file, and the ADD must win.
    for (const dropped of parseDropConstraints(sql)) live.delete(dropped);
    for (const c of parseChecks(sql, file)) live.set(c.name, c);
  }
  return live;
}

/** CHECK constraints declared in schema-pg.ts: name → predicate text. */
function checksDeclaredInSchema(): Map<string, string> {
  const src = readFileSync(SCHEMA_FILE, "utf8");
  const out = new Map<string, string>();
  const re = /\bcheck\(\s*"([^"]+)"\s*,\s*sql`([\s\S]*?)`\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.set(m[1], m[2]);
  return out;
}

/**
 * The allowed-value set of an enumerated CHECK, or null when it is not one.
 *
 * Handles both spellings, because they compile to the same thing: Postgres
 * rewrites `x IN ('a','b')` into a ScalarArrayOpExpr and `pg_get_constraintdef`
 * prints it back as `x = ANY (ARRAY['a'::text, 'b'::text])`.
 */
function enumeratedValues(predicate: string): Set<string> | null {
  const anyArray = /=\s*ANY\s*\(\s*ARRAY\s*\[([\s\S]*?)\]/i.exec(predicate);
  const inList = /\bIN\s*\(([^()]*?)\)/i.exec(predicate);
  const raw = anyArray?.[1] ?? inList?.[1];
  if (!raw) return null;
  const values = [...raw.matchAll(/'((?:[^']|'')*)'/g)].map((v) => v[1].replace(/''/g, "'"));
  return values.length ? new Set(values) : null;
}

const fromSql = checksFromMigrationChain();
const declared = checksDeclaredInSchema();
const sameSet = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((x) => b.has(x));

describe("schema-pg.ts declares every CHECK the migration chain creates", () => {
  it("parses a plausible number of checks from both sides (parser sanity)", () => {
    // Without these, a silently-broken parser makes every assertion below pass
    // vacuously. 53 is the count measured against a `db:migrate` database on
    // 2026-09-17; the floors are deliberately a little loose.
    expect(fromSql.size).toBeGreaterThanOrEqual(50);
    expect(declared.size).toBeGreaterThanOrEqual(50);
  });

  it("declares every migration-chain CHECK", () => {
    const missing = [...fromSql.values()]
      .filter((c) => !(c.name in EXEMPT))
      .filter((c) => !declared.has(c.name))
      .map((c) => `${c.name} (from ${c.source})`)
      .sort();

    expect(
      missing,
      "These CHECK constraints exist on a `npm run db:migrate` database but are " +
        "NOT declared in src/db/schema-pg.ts, so a `db:push` install will accept " +
        "values Postgres should reject. Add each one to its pgTable's third " +
        "argument in the same commit as the migration.",
    ).toEqual([]);
  });

  it("does not declare CHECKs the migration chain never creates", () => {
    // Catches a typo'd name (which leaves the real constraint undeclared AND a
    // phantom one declared) and a declaration that outlived its migration.
    const phantom = [...declared.keys()].filter((n) => !fromSql.has(n)).sort();

    expect(
      phantom,
      "Declared in src/db/schema-pg.ts but created by no baseline/migration SQL. " +
        "Either the name is a typo, or the constraint needs a migration so " +
        "existing databases get it.",
    ).toEqual([]);
  });

  it("declares the same allowed values for every enumerated CHECK", () => {
    // The assertion that earns this file. A stale value list is invisible to a
    // name-only gate and produces a runtime 23514 that our write paths swallow.
    const compared: string[] = [];
    const mismatched: string[] = [];

    for (const c of fromSql.values()) {
      const want = enumeratedValues(c.body);
      const decl = declared.get(c.name);
      if (!want || decl === undefined) continue;
      const got = enumeratedValues(decl);
      if (!got) {
        mismatched.push(
          `${c.name}: SQL enumerates ${[...want].sort().join("|")} but the ` +
            `declaration is not an enumerated form`,
        );
        continue;
      }
      compared.push(c.name);
      if (!sameSet(want, got)) {
        const missing = [...want].filter((v) => !got.has(v));
        const extra = [...got].filter((v) => !want.has(v));
        mismatched.push(
          `${c.name}: missing ${JSON.stringify(missing)}, extra ${JSON.stringify(extra)}`,
        );
      }
    }

    // Guard against the comparison silently covering nothing.
    expect(compared.length, "enumerated-CHECK comparison covered too few").toBeGreaterThan(
      35,
    );
    expect(
      mismatched.sort(),
      "The declared value list must match the migration chain's exactly — a " +
        "missing value means db:push builds a schema that REJECTS writes the " +
        "app makes, an extra one means it ACCEPTS writes prod rejects.",
    ).toEqual([]);
  });

  it("keeps SOURCES in tx-source.ts equal to transactions_source_check", () => {
    // Two allow-lists for one column. `coerceSourceForRestore` and every write
    // path validate against SOURCES; Postgres validates against the CHECK.
    const chain = fromSql.get("transactions_source_check");
    expect(chain, "transactions_source_check disappeared from the chain").toBeTruthy();
    const dbValues = enumeratedValues(chain!.body);
    expect(dbValues).toBeTruthy();

    const src = readFileSync(TX_SOURCE_FILE, "utf8");
    const block = /export const SOURCES = \[([\s\S]*?)\]\s*as const/.exec(src);
    expect(block, "SOURCES tuple not found — did it move or change shape?").toBeTruthy();
    // Strip comments: the tuple is heavily annotated and the prose quotes other
    // enum values.
    const body = block![1]
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const tuple = new Set([...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]));

    expect(tuple.size, "SOURCES parsed as empty — parser drift").toBeGreaterThan(5);
    expect(
      [...tuple].sort(),
      "src/lib/tx-source.ts and transactions_source_check must list the same " +
        "values. A source the app writes but the CHECK rejects raises 23514 " +
        "inside a try/catch and the row silently never lands.",
    ).toEqual([...dbValues!].sort());
  });

  it("keeps every EXEMPT entry justified and still real", () => {
    for (const [name, reason] of Object.entries(EXEMPT)) {
      expect(reason.length, `EXEMPT["${name}"] needs a reason`).toBeGreaterThan(20);
      expect(fromSql.has(name), `EXEMPT["${name}"] is stale — no SQL creates it`).toBe(true);
    }
  });
});
