import { AsyncLocalStorage } from "node:async_hooks";
import * as pgSchema from "./schema-pg";
import type { DatabaseAdapter, DbDialect, DrizzleDb } from "./adapter";
import { PostgresAdapter } from "./adapters/postgres";

// ─── Adapter registry ────────────────────────────────────────────────────────

const g = globalThis as typeof globalThis & {
  __pfDrizzle?: DrizzleDb | null;
  __pfAdapter?: DatabaseAdapter | null;
  __pfDialect?: DbDialect;
  __pfTxScope?: AsyncLocalStorage<DrizzleDb>;
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

// ─── Ambient transaction scope ───────────────────────────────────────────────
//
// Multi-row financial writes (portfolio operations.ts, the transaction
// delete-cascade chokepoint, edit-as-replace) must be all-or-nothing, but the
// code that performs them — `operations.ts`, `lots/write-hooks.ts`,
// `snapshots/dirty.ts`, `queries.ts` — reaches for the module-level `db`
// proxy, not a threaded `tx` handle. Threading an executor parameter through
// those ~900 lines (and every one of their other callers: import pipeline,
// bank materialize, backfill) is a far larger and riskier change than the
// atomicity fix itself.
//
// Instead the proxy consults an AsyncLocalStorage slot: inside
// `withDbTransaction(fn)` every `db.*` access in that async context resolves
// to the transaction handle, so the existing code becomes transactional
// without changing a single callsite. Outside it — i.e. everywhere that
// hasn't opted in — the store is empty and behavior is byte-identical.
//
// Rules for anything running inside `withDbTransaction`:
//   - No network I/O (it would hold a pool client open). operations.ts and
//     write-hooks.ts contain none — verified 2026-07-30.
//   - No fire-and-forget writes: a detached promise that queries after the
//     block resolves would use a released client. Await everything.
//   - Nesting is safe — an inner call JOINS the outer transaction rather than
//     opening a second one (no nested BEGIN, no savepoint churn).
//
// The store lives on `globalThis`, for the SAME reason the adapter and the MCP
// tx cache do — and this one is not merely an HMR nicety. Turbopack emits this
// module into SEVERAL server chunks (measured on dev 2026-07-30: two distinct
// copies of the proxy, and `operations.ts` / `delete-cascade.ts` / a route's
// `_helpers.ts` do not reliably land in the same one). A module-scoped
// AsyncLocalStorage therefore gives each copy its OWN scope: the outer
// `withDbTransaction` opens a real transaction in copy A while every `db.*`
// inside runs through copy B, sees an empty store, and goes to the pool —
// silently NON-transactional, which is worse than no transaction at all
// because it reads as fixed. One shared instance keyed on globalThis is what
// makes "the ambient transaction" ambient across chunk boundaries.
const txScope: AsyncLocalStorage<DrizzleDb> =
  (g.__pfTxScope ??= new AsyncLocalStorage<DrizzleDb>());

/**
 * Run `fn` with every `db.*` access in its async context bound to a single
 * Postgres transaction. Commits when `fn` resolves, ROLLS BACK when it throws
 * (the throw propagates unchanged).
 *
 * Degrades to a plain `fn()` call — no transaction — when there is no
 * initialized adapter or the adapter's db exposes no `transaction()` (unit
 * tests that mock `@/db`). That keeps a missing transaction from turning into
 * a crash in environments that never had one to begin with.
 */
export async function withDbTransaction<T>(fn: () => Promise<T>): Promise<T> {
  // Already inside one → join it. Opening a nested transaction here would
  // create a savepoint whose rollback semantics differ from the caller's
  // expectation ("the whole operation is atomic").
  if (txScope.getStore()) return fn();

  const adapter = g.__pfAdapter;
  if (!adapter) return fn();
  let adapterDb: DrizzleDb;
  try {
    adapterDb = adapter.getDb();
  } catch {
    return fn();
  }
  const runner = (adapterDb as { transaction?: unknown }).transaction;
  if (typeof runner !== "function") return fn();

  return adapterDb.transaction(async (tx) =>
    txScope.run(tx as unknown as DrizzleDb, fn),
  ) as Promise<T>;
}

/** True while the caller is inside a `withDbTransaction` block. */
export function inDbTransaction(): boolean {
  return txScope.getStore() != null;
}

/**
 * Lazy Proxy — all existing `import { db } from "@/db"` calls continue to work.
 *
 * The proxy delegates to the PostgreSQL adapter, or to the ambient transaction
 * handle when one is active (see `withDbTransaction`).
 */
export const db = new Proxy({} as DrizzleDb, {
  get(_target, prop, receiver) {
    const ambientTx = txScope.getStore();
    const adapter = g.__pfAdapter;
    if (!ambientTx && !adapter) {
      throw new Error("Database adapter not initialized. Call setAdapter() first.");
    }
    const adapterDb = ambientTx ?? adapter!.getDb();
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
