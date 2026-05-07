/**
 * PostgreSQL compatibility layer for MCP server tools.
 *
 * The original MCP tools were written for better-sqlite3's synchronous API:
 *   sqlite.prepare(sql).all(...params)
 *   sqlite.prepare(sql).get(...params)
 *   sqlite.prepare(sql).run(...params)
 *
 * This module provides a drop-in async replacement backed by `pg.Pool`.
 * It auto-converts `?` placeholders to PostgreSQL's `$1, $2, …` style
 * and translates common SQLite functions to their PostgreSQL equivalents.
 */

import { Pool, PoolClient } from "pg";

/* ------------------------------------------------------------------ */
/*  SQL translation helpers                                           */
/* ------------------------------------------------------------------ */

/**
 * Replace `?` positional params with `$1`, `$2`, … — but ONLY outside string
 * literals.
 *
 * The previous one-line `.replace(/\?/g, ...)` rewrote `?` characters that
 * appeared inside `'...'` and `"..."` string literals, corrupting any literal
 * SQL string that legitimately contained a `?` (M-4 in SECURITY_REVIEW
 * 2026-05-06). Defense-in-depth — none of the callers in the current tree
 * embed `?` inside literals, but the failure mode if any does is silent
 * payload corruption.
 *
 * State machine handles:
 *   - single-quoted strings `'...'`        with SQL escape `''`
 *   - double-quoted identifiers `"..."`    with SQL escape `""`
 *   - line comments `-- …\n`               (don't replace inside)
 *   - block comments `/* … *\/`            (don't replace inside)
 *   - dollar-quoted strings `$tag$ … $tag$` (don't replace inside)
 */
export function convertPlaceholders(sqlText: string): string {
  let out = "";
  let idx = 0;
  let i = 0;
  const n = sqlText.length;
  while (i < n) {
    const ch = sqlText[i];
    const next = i + 1 < n ? sqlText[i + 1] : "";

    // Line comment -- ... \n
    if (ch === "-" && next === "-") {
      const eol = sqlText.indexOf("\n", i + 2);
      if (eol === -1) {
        out += sqlText.slice(i);
        return out;
      }
      out += sqlText.slice(i, eol + 1);
      i = eol + 1;
      continue;
    }

    // Block comment /* ... */
    if (ch === "/" && next === "*") {
      const end = sqlText.indexOf("*/", i + 2);
      if (end === -1) {
        out += sqlText.slice(i);
        return out;
      }
      out += sqlText.slice(i, end + 2);
      i = end + 2;
      continue;
    }

    // Single-quoted string literal '...' (with '' escape)
    if (ch === "'") {
      out += ch;
      i++;
      while (i < n) {
        const c = sqlText[i];
        if (c === "'") {
          // Possible '' escape — copy both and continue inside the literal.
          if (i + 1 < n && sqlText[i + 1] === "'") {
            out += "''";
            i += 2;
            continue;
          }
          out += "'";
          i++;
          break;
        }
        out += c;
        i++;
      }
      continue;
    }

    // Double-quoted identifier "..." (with "" escape)
    if (ch === '"') {
      out += ch;
      i++;
      while (i < n) {
        const c = sqlText[i];
        if (c === '"') {
          if (i + 1 < n && sqlText[i + 1] === '"') {
            out += '""';
            i += 2;
            continue;
          }
          out += '"';
          i++;
          break;
        }
        out += c;
        i++;
      }
      continue;
    }

    // Dollar-quoted string $tag$...$tag$  (tag may be empty: $$...$$).
    // Tag chars per Postgres: letters, digits, underscore (no leading digit),
    // but we accept anything matching /[A-Za-z0-9_]*/.
    if (ch === "$") {
      // Look ahead for the closing $ of the opening tag.
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(sqlText[j])) j++;
      if (j < n && sqlText[j] === "$") {
        const tag = sqlText.slice(i, j + 1); // e.g. "$$" or "$foo$"
        const closeAt = sqlText.indexOf(tag, j + 1);
        if (closeAt !== -1) {
          out += sqlText.slice(i, closeAt + tag.length);
          i = closeAt + tag.length;
          continue;
        }
      }
      // Not a dollar-quoted opening — fall through.
      out += ch;
      i++;
      continue;
    }

    // Question mark — replace outside any literal/comment.
    if (ch === "?") {
      out += `$${++idx}`;
      i++;
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/** Translate SQLite-specific SQL to PostgreSQL equivalents */
function translateSql(sqlText: string): string {
  let out = sqlText;

  // strftime('%Y-%m', col)  →  to_char(col, 'YYYY-MM')
  out = out.replace(
    /strftime\(\s*'%Y-%m'\s*,\s*([^)]+)\)/gi,
    "to_char($1::date, 'YYYY-MM')"
  );

  // strftime('%Y-%W', col)  →  to_char(col, 'IYYY-IW')
  out = out.replace(
    /strftime\(\s*'%Y-%W'\s*,\s*([^)]+)\)/gi,
    "to_char($1::date, 'IYYY-IW')"
  );

  // strftime('%Y', col)  →  to_char(col, 'YYYY')
  out = out.replace(
    /strftime\(\s*'%Y'\s*,\s*([^)]+)\)/gi,
    "to_char($1::date, 'YYYY')"
  );

  // strftime('%m', col)  →  to_char(col, 'MM')
  out = out.replace(
    /strftime\(\s*'%m'\s*,\s*([^)]+)\)/gi,
    "to_char($1::date, 'MM')"
  );

  // strftime('%w', col)  →  extract(dow from col)::int
  out = out.replace(
    /strftime\(\s*'%w'\s*,\s*([^)]+)\)/gi,
    "extract(dow from $1::date)::int"
  );

  // Generic remaining strftime — best-effort passthrough
  out = out.replace(
    /strftime\(\s*'([^']+)'\s*,\s*([^)]+)\)/gi,
    (_, fmt: string, col: string) => {
      const pgFmt = fmt
        .replace(/%Y/g, "YYYY")
        .replace(/%m/g, "MM")
        .replace(/%d/g, "DD")
        .replace(/%H/g, "HH24")
        .replace(/%M/g, "MI")
        .replace(/%S/g, "SS")
        .replace(/%W/g, "IW");
      return `to_char(${col}::date, '${pgFmt}')`;
    }
  );

  // SQLite date('now') → CURRENT_DATE
  out = out.replace(/date\(\s*'now'\s*\)/gi, "CURRENT_DATE");

  // SQLite datetime('now') → NOW()
  out = out.replace(/datetime\(\s*'now'\s*\)/gi, "NOW()");

  // SQLite IFNULL → COALESCE
  out = out.replace(/IFNULL\s*\(/gi, "COALESCE(");

  // SQLite GROUP_CONCAT → STRING_AGG
  out = out.replace(/GROUP_CONCAT\s*\(\s*([^,)]+)\s*,\s*'([^']+)'\s*\)/gi, "STRING_AGG($1::text, '$2')");
  out = out.replace(/GROUP_CONCAT\s*\(\s*([^)]+)\s*\)/gi, "STRING_AGG($1::text, ',')");

  // SQLite TOTAL() → COALESCE(SUM(), 0)
  out = out.replace(/\bTOTAL\s*\(\s*([^)]+)\s*\)/gi, "COALESCE(SUM($1), 0)");

  // Convert ? placeholders to $N (literal-aware).
  out = convertPlaceholders(out);

  return out;
}

/** Exported for tests. */
export const __internals = { translateSql, convertPlaceholders };

/* ------------------------------------------------------------------ */
/*  PgCompat — the compatibility interface                            */
/* ------------------------------------------------------------------ */

export interface PreparedStatement {
  all(...params: unknown[]): Promise<unknown[]>;
  get(...params: unknown[]): Promise<unknown | undefined>;
  run(...params: unknown[]): Promise<{ changes: number; lastInsertRowid: number }>;
}

/**
 * A query-shaped handle. Top-level `PgCompatDb` and the `tx` argument passed
 * to `transaction(fn)` both satisfy this — the BEGIN-ed client wraps a single
 * `PoolClient`, so every prepare/query call inside the fn rides the same
 * connection (and therefore the same BEGIN/COMMIT/ROLLBACK boundary).
 */
export interface PgCompatQuerier {
  prepare(sql: string): PreparedStatement;
  query(sql: string, params?: unknown[]): Promise<unknown[]>;
}

export interface PgCompatDb extends PgCompatQuerier {
  /**
   * Run `fn` inside a single BEGIN/COMMIT. The argument passed to `fn` is a
   * `PgCompatQuerier` bound to the BEGIN-ed `PoolClient` — every prepare/query
   * call on it lands on the same connection, so a thrown error correctly
   * rolls back every statement run inside.
   *
   * (M-3 in SECURITY_REVIEW 2026-05-06: the previous signature took a no-arg
   * fn whose body called the OUTER `db.prepare(...)`, which acquired a fresh
   * pool client per call. The "transaction" was a no-op — ROLLBACK on the
   * BEGIN-ed client couldn't undo writes that ran on sibling clients.)
   */
  transaction<T>(fn: (tx: PgCompatQuerier) => Promise<T>): Promise<T>;
  pool: Pool;
}

/** Build a query-shaped handle bound to a specific PoolClient. */
function querierForClient(client: PoolClient): PgCompatQuerier {
  const pgSql = (sql: string) => translateSql(sql);
  return {
    prepare(sql: string): PreparedStatement {
      const translated = pgSql(sql);
      return {
        async all(...params: unknown[]): Promise<unknown[]> {
          const result = await client.query(translated, params);
          return result.rows;
        },
        async get(...params: unknown[]): Promise<unknown | undefined> {
          const result = await client.query(translated, params);
          return result.rows[0];
        },
        async run(...params: unknown[]): Promise<{ changes: number; lastInsertRowid: number }> {
          const result = await client.query(translated, params);
          const lastId = result.rows[0]?.id ?? 0;
          return {
            changes: result.rowCount ?? 0,
            lastInsertRowid: lastId,
          };
        },
      };
    },
    async query(sql: string, params?: unknown[]): Promise<unknown[]> {
      const translated = pgSql(sql);
      const result = await client.query(translated, params);
      return result.rows;
    },
  };
}

export function createPgCompat(pool: Pool): PgCompatDb {
  const pgSql = (sql: string) => translateSql(sql);

  return {
    pool,

    prepare(sql: string): PreparedStatement {
      const translated = pgSql(sql);

      return {
        async all(...params: unknown[]): Promise<unknown[]> {
          const client = await pool.connect();
          try {
            const result = await client.query(translated, params);
            return result.rows;
          } finally {
            client.release();
          }
        },

        async get(...params: unknown[]): Promise<unknown | undefined> {
          const client = await pool.connect();
          try {
            const result = await client.query(translated, params);
            return result.rows[0];
          } finally {
            client.release();
          }
        },

        async run(...params: unknown[]): Promise<{ changes: number; lastInsertRowid: number }> {
          const client = await pool.connect();
          try {
            const result = await client.query(translated, params);
            const lastId = result.rows[0]?.id ?? 0;
            return {
              changes: result.rowCount ?? 0,
              lastInsertRowid: lastId,
            };
          } finally {
            client.release();
          }
        },
      };
    },

    async transaction<T>(fn: (tx: PgCompatQuerier) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const tx = querierForClient(client);
        const result = await fn(tx);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Swallow rollback errors — surface the original exception.
        }
        throw err;
      } finally {
        client.release();
      }
    },

    async query(sql: string, params?: unknown[]): Promise<unknown[]> {
      const client = await pool.connect();
      try {
        const translated = pgSql(sql);
        const result = await client.query(translated, params);
        return result.rows;
      } finally {
        client.release();
      }
    },
  };
}
