import * as pgSchema from "./schema-pg";
import type { DatabaseAdapter, DbDialect, DrizzleDb } from "./adapter";
import { PostgresAdapter } from "./adapters/postgres";

// ─── Adapter registry ────────────────────────────────────────────────────────

const g = globalThis as typeof globalThis & {
  __pfDrizzle?: DrizzleDb | null;
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

/** Get the current dialect (defaults to "postgres") */
export function getDialect(): DbDialect {
  return g.__pfDialect ?? "postgres";
}

/** Set the active dialect */
export function setDialect(dialect: DbDialect): void {
  g.__pfDialect = dialect;
}

/** Reset the cached Drizzle instance (call after close) */
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
      // .all() in PG mode: execute the query and return a real Promise<rows[]>.
      // Using async/await here (rather than () => target) ensures the return value
      // is always a concrete Promise that resolves to an array, never a bare thenable.
      // This prevents "x.map is not a function" when callers don't double-await.
      if (prop === "all") return async () => { const rows = await target; return Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? []; };
      // .get() in PG mode: execute and return first row
      if (prop === "get") return async () => { const rows = await target; return Array.isArray(rows) ? rows[0] ?? undefined : rows; };
      // .run() in PG mode: execute write query (INSERT/UPDATE/DELETE) and return result
      if (prop === "run") return async () => { return await target; };
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
 * The proxy delegates to the PostgreSQL adapter.
 */
export const db = new Proxy({} as DrizzleDb, {
  get(_target, prop, receiver) {
    const adapter = g.__pfAdapter;
    if (!adapter) {
      throw new Error("Database adapter not initialized. Call setAdapter() first.");
    }
    const adapterDb = adapter.getDb();
    const value = Reflect.get(adapterDb, prop, receiver);
    if (typeof value === "function") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (...args: any[]) => wrapPgBuilder((value as (...a: any[]) => any).apply(adapterDb, args));
    }
    return value;
  },
});

/**
 * Schema export — always PostgreSQL schema (PostgreSQL-only mode)
 */
export const schema = pgSchema;

export type { DatabaseAdapter, DbDialect, DrizzleDb };
export { DEFAULT_USER_ID } from "./adapter";
export { PostgresAdapter };
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
