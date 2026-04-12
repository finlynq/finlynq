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

import { Pool } from "pg";

/* ------------------------------------------------------------------ */
/*  SQL translation helpers                                           */
/* ------------------------------------------------------------------ */

/** Replace `?` positional params with `$1`, `$2`, … */
function convertPlaceholders(sql: string): string {
  let idx = 0;
  return sql.replace(/\?/g, () => `$${++idx}`);
}

/** Translate SQLite-specific SQL to PostgreSQL equivalents */
function translateSql(sql: string): string {
  let out = sql;

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

  // Convert ? placeholders to $N
  out = convertPlaceholders(out);

  return out;
}

/* ------------------------------------------------------------------ */
/*  PgCompat — the compatibility interface                            */
/* ------------------------------------------------------------------ */

export interface PreparedStatement {
  all(...params: unknown[]): Promise<unknown[]>;
  get(...params: unknown[]): Promise<unknown | undefined>;
  run(...params: unknown[]): Promise<{ changes: number; lastInsertRowid: number }>;
}

export interface PgCompatDb {
  prepare(sql: string): PreparedStatement;
  transaction<T>(fn: () => T | Promise<T>): () => Promise<T>;
  query(sql: string, params?: unknown[]): Promise<unknown[]>;
  pool: Pool;
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

    transaction<T>(fn: () => T | Promise<T>): () => Promise<T> {
      return async () => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await fn();
          await client.query("COMMIT");
          return result;
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
      };
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
