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
 * Wraps a PG Drizzle query builder so that .all() is a valid no-op that
 * returns the same awaitable object.  Every chained method (from/where/
 * groupBy/orderBy/limit/offset/leftJoin/returning…) is also wrapped so
 * the whole chain stays compatible with the SQLite .all() call sites.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapPgBuilder(obj: any): any {
  if (!obj || typeof obj !== "object") return obj;
  return new Proxy(obj, {
    get(target, prop) {
      // .all() in PG mode: just return the awaitable query builder itself
      if (prop === "all") return () => target;
      // .get() in PG mode: execute and return first row
      if (prop === "get") return async () => { const rows = await target; return rows[0] ?? undefined; };
      const val = Reflect.get(target, prop);
      if (typeof val === "function") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (...args: any[]) => wrapPgBuilder(val.apply(target, args));
      }
      return val;
    },
  });
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (...args: any[]) => wrapPgBuilder((value as (...a: any[]) => any).apply(adapterDb, args));
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
// Proxy switches between SQLite and PG schemas at runtime.
// Target is {} to avoid ES module non-configurable property invariant violations.
// Typed as sqliteSchema for TypeScript inference; PG schema used at runtime only.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const schema = new Proxy({} as typeof sqliteSchema, {
  get(_target, prop) {
    const dialect = g.__pfDialect ?? "sqlite";
    const activeSchema = dialect === "postgres" ? pgSchema : sqliteSchema;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (activeSchema as any)[prop as string];
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
