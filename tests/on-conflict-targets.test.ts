/**
 * Static gate: every Drizzle `ON CONFLICT` target in the codebase must name a
 * column set that some declared PRIMARY KEY / UNIQUE constraint in
 * `src/db/schema-pg.ts` actually covers.
 *
 * WHY THIS EXISTS
 * ---------------
 * Postgres arbitrates `INSERT ... ON CONFLICT (<cols>)` against a unique index
 * or constraint whose column set EQUALS `<cols>`. Name a subset, a superset, or
 * an unrelated column and it does not fall back to anything — it raises 42P10
 * "there is no unique or exclusion constraint matching the ON CONFLICT
 * specification", every time, on every database. This is not environment
 * dependent and no amount of data makes it work.
 *
 * That is a nastier failure than it sounds because our upsert callsites are
 * routinely wrapped in a broad `try`/`catch` or a `.catch(() => {})`, so the
 * write simply never happens and the user is told nothing. The instance that
 * prompted this file: `POST /api/data/import` (backup restore) upserted every
 * `settings` row with `target: schema.settings.key`, while `settings` has
 * exactly one unique constraint — the composite PK `(key, user_id)`. Restoring
 * a backup therefore always failed at its final step.
 *
 * Its sibling gate, `schema-index-parity.test.ts`, checks that every index the
 * MIGRATION chain creates is also DECLARED in `schema-pg.ts`. This one checks
 * the other half: that the constraints we declare are the ones our upserts
 * actually name. Together they close both sides of a 42P10.
 *
 * WHAT THIS CHECKS
 * ----------------
 * Pure text parsing — no database, no mocks.
 *
 *   1. Parse `schema-pg.ts` into tables, and per table collect every column set
 *      that is uniquely constrained: `.primaryKey()` / `.unique()` on a column,
 *      `primaryKey({ columns: [...] })`, `unique("...").on(...)`, and
 *      `uniqueIndex("...").on(...)`.
 *   2. Parse every `.onConflictDoUpdate({ target: ... })` /
 *      `.onConflictDoNothing({ target: ... })` under `src/`, `mcp-server/`,
 *      `scripts/` and `packages/`, resolving `schema.<table>.<col>` (and the
 *      bare `<table>.<col>` form some modules import directly).
 *   3. Assert each target's column set matches one of those constraints
 *      exactly, as a SET (Postgres ignores conflict-target column order).
 *
 * A bare `onConflictDoNothing()` with no target is legal and unconstrained —
 * Postgres then arbitrates on ANY unique violation — so those are skipped.
 *
 * Raw-SQL `ON CONFLICT (...)` strings are NOT covered here; they are a small,
 * stable set and were audited by hand alongside this file.
 *
 * WHEN THIS FAILS
 * ---------------
 * Either your new upsert names the wrong columns, or the unique constraint it
 * relies on is missing from `schema-pg.ts`. Fix whichever is actually wrong —
 * but never "fix" it by loosening the target to a subset, which is precisely
 * the bug this catches.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..");
const SCHEMA_FILE = path.join(ROOT, "src/db/schema-pg.ts");
const SCAN_DIRS = ["src", "mcp-server", "scripts", "packages"];

// ─── schema-pg.ts: tables → their uniquely-constrained column sets ──────────

type TableInfo = {
  /** Drizzle export name, e.g. `settings`. */
  varName: string;
  /** SQL table name, e.g. `settings`. */
  sqlName: string;
  /** Each entry is one unique/PK constraint, as a set of Drizzle column props. */
  uniqueSets: Set<string>[];
  /** Human labels for the sets above, same order, for failure messages. */
  uniqueLabels: string[];
};

/**
 * Split `schema-pg.ts` into one text block per `export const X = pgTable(...)`.
 * A block runs to the next top-level `export ` — good enough because every
 * table declaration in this file is a single top-level statement.
 */
function tableBlocks(src: string): { varName: string; sqlName: string; body: string }[] {
  const re = /^export const (\w+) = pgTable\(\s*\n?\s*"([^"]+)"/gm;
  const starts: { varName: string; sqlName: string; at: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    starts.push({ varName: m[1], sqlName: m[2], at: m.index });
  }
  return starts.map((s, i) => {
    const nextExport = src.indexOf("\nexport ", s.at + 1);
    const end =
      i + 1 < starts.length
        ? starts[i + 1].at
        : nextExport === -1
          ? src.length
          : nextExport;
    return { varName: s.varName, sqlName: s.sqlName, body: src.slice(s.at, end) };
  });
}

/**
 * The column property a `.primaryKey()` / `.unique()` call belongs to: the
 * nearest preceding indented `name:` property. Column declarations span several
 * lines when they carry `.references(...)`, so scanning backwards for the
 * property header is more robust than trying to match the whole declaration in
 * one regex. The indent is 2 or 4 spaces depending on whether the table's
 * column object sits on the `pgTable(` line or on its own.
 */
function columnOwningModifier(body: string, modifierAt: number): string | null {
  const before = body.slice(0, modifierAt);
  const matches = [...before.matchAll(/^ {2,6}(\w+):/gm)];
  return matches.length ? matches[matches.length - 1][1] : null;
}

/** Column props referenced inside an `.on(...)` / `columns: [...]` argument list. */
function columnsInArgs(args: string): string[] {
  // `t.userId`, `table.key`, `t.date.desc().nullsFirst()` — take the property
  // directly after the callback parameter, ignoring any modifier chain.
  return [...args.matchAll(/\b\w+\.(\w+)\b/g)]
    .map((m) => m[1])
    .filter((c) => !["desc", "asc", "nullsFirst", "nullsLast", "on", "where"].includes(c));
}

/**
 * Blank out `/* *\/` blocks and whole-line `//` comments, preserving line
 * count and offsets so reported line numbers stay accurate. Deliberately does
 * NOT touch trailing `//` comments — that would need string/regex awareness
 * (`"http://…"`), and a comment can only hide a `target:` when it sits on its
 * own line before it.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^[ \t]*\/\/.*$/gm, (m) => " ".repeat(m.length));
}

/** Read the balanced `(...)` argument text starting at `openParenAt`. */
function balancedArgs(body: string, openParenAt: number): string {
  let depth = 0;
  for (let i = openParenAt; i < body.length; i++) {
    if (body[i] === "(") depth++;
    else if (body[i] === ")") {
      depth--;
      if (depth === 0) return body.slice(openParenAt + 1, i);
    }
  }
  return "";
}

function parseSchema(): Map<string, TableInfo> {
  const src = readFileSync(SCHEMA_FILE, "utf8");
  const out = new Map<string, TableInfo>();

  for (const { varName, sqlName, body } of tableBlocks(src)) {
    const uniqueSets: Set<string>[] = [];
    const uniqueLabels: string[] = [];
    const add = (cols: string[], label: string) => {
      if (!cols.length) return;
      uniqueSets.push(new Set(cols));
      uniqueLabels.push(`${label} (${[...cols].sort().join(", ")})`);
    };

    // Column-level `.primaryKey()` / `.unique()`.
    for (const m of body.matchAll(/\.(primaryKey|unique)\(\s*\)/g)) {
      const col = columnOwningModifier(body, m.index!);
      if (col) add([col], `column .${m[1]}()`);
    }

    // Composite `primaryKey({ columns: [t.a, t.b] })`.
    for (const m of body.matchAll(/primaryKey\(\s*\{\s*columns:\s*\[([^\]]*)\]/g)) {
      add(columnsInArgs(m[1]), "composite primaryKey");
    }

    // `unique("name").on(...)` / `uniqueIndex("name").on(...)`.
    for (const m of body.matchAll(/\b(unique|uniqueIndex)\(\s*"([^"]+)"\s*\)\s*\.on/g)) {
      const onParen = body.indexOf("(", m.index! + m[0].length - 1);
      if (onParen === -1) continue;
      add(columnsInArgs(balancedArgs(body, onParen)), `${m[1]}("${m[2]}")`);
    }

    out.set(varName, { varName, sqlName, uniqueSets, uniqueLabels });
  }
  return out;
}

// ─── callsites: every Drizzle onConflict target in the tree ─────────────────

type Target = { file: string; line: number; table: string; cols: string[]; raw: string };

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "dist") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx|mts|mjs)$/.test(entry)) acc.push(full);
  }
  return acc;
}

function parseTargets(tables: Map<string, TableInfo>): {
  targets: Target[];
  unresolved: string[];
} {
  const targets: Target[] = [];
  const unresolved: string[] = [];

  for (const dir of SCAN_DIRS) {
    const abs = path.join(ROOT, dir);
    for (const file of walk(abs)) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("onConflictDo")) continue;
      const rel = path.relative(ROOT, file).replace(/\\/g, "/");

      // Comments are stripped first: a `// ...` block between `onConflictDo…({`
      // and `target:` would otherwise hide the callsite from this scan
      // entirely, which is a silent pass — the worst outcome for a gate.
      const code = stripComments(src);

      const re = /onConflictDo(?:Update|Nothing)\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(code))) {
        const args = balancedArgs(code, re.lastIndex - 1);
        const t = /(?:^|[\s,{])target:\s*(\[[^\]]*\]|[\w.]+)/.exec(args);
        // A bare `onConflictDoNothing()` has no target — legal, and Postgres
        // then arbitrates on ANY unique violation, so there is nothing to check.
        if (!t) continue;
        const raw = t[1];
        const refs = [...raw.matchAll(/(?:schema\.)?(\w+)\.(\w+)/g)].map((r) => ({
          table: r[1],
          col: r[2],
        }));
        const line = code.slice(0, m.index).split("\n").length;
        if (!refs.length) {
          unresolved.push(`${rel}:${line} — could not parse target \`${raw}\``);
          continue;
        }
        const tableVars = new Set(refs.map((r) => r.table));
        if (tableVars.size !== 1) {
          unresolved.push(`${rel}:${line} — target spans several tables: \`${raw}\``);
          continue;
        }
        const table = refs[0].table;
        if (!tables.has(table)) {
          unresolved.push(`${rel}:${line} — unknown table \`${table}\` in \`${raw}\``);
          continue;
        }
        targets.push({ file: rel, line, table, cols: refs.map((r) => r.col), raw });
      }
    }
  }
  return { targets, unresolved };
}

// ─── assertions ────────────────────────────────────────────────────────────

const tables = parseSchema();
const { targets, unresolved } = parseTargets(tables);

const sameSet = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((x) => b.has(x));

describe("every Drizzle ON CONFLICT target is backed by a declared unique constraint", () => {
  it("parses a plausible amount from both sides (parser sanity)", () => {
    // Without these, a silently-broken parser makes every other assertion here
    // pass vacuously.
    expect(tables.size).toBeGreaterThan(40);
    expect(tables.get("settings")?.uniqueSets.length ?? 0).toBeGreaterThan(0);
    expect(targets.length).toBeGreaterThan(15);
  });

  it("resolves every onConflict target it finds", () => {
    expect(
      unresolved,
      "This gate must not silently skip a callsite. Either the target uses a " +
        "form the parser does not understand (extend it), or it names a table " +
        "that is not declared in src/db/schema-pg.ts.",
    ).toEqual([]);
  });

  it("matches each target to a PK/UNIQUE constraint on that table", () => {
    const bad = targets
      .filter((t) => {
        const info = tables.get(t.table)!;
        const want = new Set(t.cols);
        return !info.uniqueSets.some((s) => sameSet(s, want));
      })
      .map((t) => {
        const info = tables.get(t.table)!;
        return (
          `${t.file}:${t.line} — ON CONFLICT (${[...new Set(t.cols)].sort().join(", ")}) ` +
          `on \`${info.sqlName}\`, which declares only: ` +
          (info.uniqueLabels.length ? info.uniqueLabels.join("; ") : "NO unique constraint")
        );
      })
      .sort();

    expect(
      bad,
      "Postgres arbitrates ON CONFLICT against a unique index/constraint whose " +
        "column set EQUALS the target. A subset, superset or unrelated column " +
        "raises 42P10 on every database, and our upserts usually sit inside a " +
        "try/catch, so the write just silently never happens.",
    ).toEqual([]);
  });

  it("pins the settings upserts to the composite PK (key, user_id)", () => {
    // The specific regression: `settings` is upserted from ~20 places and its
    // ONLY unique constraint is `settings_pkey (key, user_id)`. A key-only
    // target made backup restore fail at its last step on every database.
    const settingsTargets = targets.filter((t) => t.table === "settings");
    expect(settingsTargets.length).toBeGreaterThan(5);
    for (const t of settingsTargets) {
      expect(
        [...new Set(t.cols)].sort(),
        `${t.file}:${t.line} must target both settings PK columns`,
      ).toEqual(["key", "userId"]);
    }
  });
});
