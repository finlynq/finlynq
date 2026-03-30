import { drizzle } from "drizzle-orm/better-sqlite3";
import * as sqliteSchema from "./schema";
import * as pgSchema from "./schema-pg";
import { getConnection } from "./connection";
import type { DatabaseAdapter, DbDialect, DrizzleDb } from "./adapter";
import { SqliteAdapter } from "./adapters/sqlite";
import { PostgresAdapter } from "./adapters/postgres";

type DrizzleSqliteDb = ReturnType<typeof drizzle<typeof sqliteSchema>>;

// ─── Adapter registry ────────────────────────────────────────────────────────

const g = globalThis as typeof globalThis & {
  __pfDrizzle?: DrizzleSqliteDb | null;
  __pfAdapter?: DatabaseAdapter | null;
  __pfDialect?: DbDialect;
};

/** Get or create the active database adapter */
export function getAdapter(): DatabaseAdapter | null {
  return g.__pfAdapter ?? null;
}

/** Set the active database adapter (called during initialization) */
export function setAdapter(adapter: DatabaseAdapter): void {
  g.__pfAdapter = adapter;
}

/** Get the current dialect (defaults to "sqlite" for backward compat) */
export function getDialect(): DbDialect {
  return g.__pfDialect ?? "sqlite";
}

/** Set the active dialect */
export function setDialect(dialect: DbDialect): void {
  g.__pfDialect = dialect;
}

// ─── Backward-compatible SQLite Drizzle instance ─────────────────────────────

function getDb(): DrizzleSqliteDb {
  if (!g.__pfDrizzle) {
    const sqlite = getConnection(); // throws DatabaseLockedError if not unlocked
    g.__pfDrizzle = drizzle(sqlite, { schema: sqliteSchema });
  }
  return g.__pfDrizzle;
}

/** Reset the cached Drizzle instance (call after lock/close) */
export function resetDb(): void {
  g.__pfDrizzle = null;
}

/**
 * Lazy Proxy — all existing `import { db } from "@/db"` calls continue to work.
 *
 * When the adapter is set to PostgreSQL, the proxy delegates to the PG adapter.
 * Otherwise it falls through to the existing SQLite behavior.
 */
export const db = new Proxy({} as DrizzleSqliteDb, {
  get(_target, prop, receiver) {
    // If a non-SQLite adapter is active, delegate to it
    const adapter = g.__pfAdapter;
    if (adapter && adapter.dialect !== "sqlite") {
      const adapterDb = adapter.getDb();
      const value = Reflect.get(adapterDb, prop, receiver);
      if (typeof value === "function") {
        return value.bind(adapterDb);
      }
      return value;
    }

    // Default: existing SQLite path
    const real = getDb();
    const value = Reflect.get(real, prop, receiver);
    if (typeof value === "function") {
      return value.bind(real);
    }
    return value;
  },
});

/**
 * Schema export — returns the correct schema for the active dialect.
 * PG schema when PostgreSQL adapter is active, SQLite schema otherwise.
 */
export const schema = new Proxy(sqliteSchema as typeof sqliteSchema & typeof pgSchema, {
  get(_target, prop, receiver) {
    const dialect = g.__pfDialect ?? "sqlite";
    const activeSchema = dialect === "postgres" ? pgSchema : sqliteSchema;
    return Reflect.get(activeSchema, prop, receiver);
  },
});
export type { DatabaseAdapter, DbDialect, DrizzleDb };
export { DEFAULT_USER_ID } from "./adapter";
export { SqliteAdapter, PostgresAdapter };
export {
  initializeConnection,
  isUnlocked,
  closeConnection,
  getConnection,
  getMode,
  getDbPath,
  isCloudReadOnly,
  DatabaseLockedError,
} from "./connection";
