import { drizzle } from "drizzle-orm/better-sqlite3";
import * as sqliteSchema from "./schema";
import * as pgSchema from "./schema-pg";
import { getConnection } from "./connection";
import type { DatabaseAdapter, DbDialect, DrizzleDb } from "./adapter";
import { SqliteAdapter } from "./adapters/sqlite";
import { PostgresAdapter } from "./adapters/postgres";

type DrizzleSqliteDb = ReturnType<typeof drizzle<typeof sqliteSchema>>;

/**
 * Add SQLite-compatible .all(), .get(), .run() methods to a PG query builder.
 * These are added non-destructively — if the property already exists it's left alone.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addSqliteCompat(obj: any): any {
  if (!obj || typeof obj !== "object") return obj;

  // .all() → returns the thenable itself (awaiting it returns rows)
  if (!obj.all) {
    Object.defineProperty(obj, "all", {
      value: function () { return this; },
      configurable: true,
      writable: true,
    });
  }

  // .get() → awaits and returns first row
  if (!obj.get && typeof obj.then === "function") {
    Object.defineProperty(obj, "get", {
      value: function () {
        return this.then((rows: unknown[]) => rows?.[0] ?? undefined);
      },
      configurable: true,
      writable: true,
    });
  }

  // .run() → awaits and discards result
  if (!obj.run && typeof obj.then === "function") {
    Object.defineProperty(obj, "run", {
      value: function () {
        return this.then(() => undefined);
      },
      configurable: true,
      writable: true,
    });
  }

  // Wrap chainable methods so the compat methods propagate through the chain
  const chainMethods = [
    "from", "where", "orderBy", "groupBy", "limit", "offset",
    "leftJoin", "innerJoin", "rightJoin", "fullJoin",
    "having", "set", "values", "returning", "onConflictDoNothing",
    "onConflictDoUpdate",
  ];
  for (const method of chainMethods) {
    const original = obj[method];
    if (typeof original === "function" && !original.__pgCompat) {
      const wrapped = function (this: unknown, ...args: unknown[]) {
        const result = original.apply(this, args);
        if (result && typeof result === "object") {
          return addSqliteCompat(result);
        }
        return result;
      };
      (wrapped as unknown as { __pgCompat: boolean }).__pgCompat = true;
      obj[method] = wrapped;
    }
  }

  return obj;
}

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
 * When the adapter is set to PostgreSQL, the proxy delegates to the PG adapter
 * and patches query builders with SQLite-compatible .all()/.get()/.run() shims.
 * Otherwise it falls through to the existing SQLite behavior.
 */
export const db = new Proxy({} as DrizzleSqliteDb, {
  get(_target, prop, receiver) {
    // If a non-SQLite adapter is active, delegate to it
    const adapter = g.__pfAdapter;
    if (adapter && adapter.dialect !== "sqlite") {
      const adapterDb = adapter.getDb();
      const value = Reflect.get(adapterDb, prop, adapterDb);
      if (typeof value === "function") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return function (this: unknown, ...args: any[]) {
          const result = value.apply(adapterDb, args);
          if (result && typeof result === "object") {
            return addSqliteCompat(result);
          }
          return result;
        };
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
 *
 * NOTE: The proxy target MUST be a plain object `{}`, NOT `sqliteSchema`.
 * ES module namespace objects have non-configurable, non-writable properties.
 * If the target were `sqliteSchema`, returning `pgSchema.accounts` when the
 * target has a different `accounts` value violates the Proxy invariant and
 * throws: "property 'X' is a read-only and non-configurable data property
 * on the proxy target but the proxy did not return its actual value".
 */
export const schema = new Proxy({} as typeof sqliteSchema & typeof pgSchema, {
  get(_target, prop, _receiver) {
    const dialect = g.__pfDialect ?? "sqlite";
    const activeSchema = dialect === "postgres" ? pgSchema : sqliteSchema;
    return Reflect.get(activeSchema, prop, activeSchema);
  },
  has(_target, prop) {
    const dialect = g.__pfDialect ?? "sqlite";
    const activeSchema = dialect === "postgres" ? pgSchema : sqliteSchema;
    return Reflect.has(activeSchema, prop);
  },
  ownKeys() {
    const dialect = g.__pfDialect ?? "sqlite";
    const activeSchema = dialect === "postgres" ? pgSchema : sqliteSchema;
    return Reflect.ownKeys(activeSchema);
  },
  getOwnPropertyDescriptor(_target, prop) {
    const dialect = g.__pfDialect ?? "sqlite";
    const activeSchema = dialect === "postgres" ? pgSchema : sqliteSchema;
    return Reflect.getOwnPropertyDescriptor(activeSchema, prop);
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
