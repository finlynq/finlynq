import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import { getConnection } from "./connection";

type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

// Persist Drizzle instance across HMR in development
const g = globalThis as typeof globalThis & { __pfDrizzle?: DrizzleDb | null };

function getDb(): DrizzleDb {
  if (!g.__pfDrizzle) {
    const sqlite = getConnection(); // throws DatabaseLockedError if not unlocked
    g.__pfDrizzle = drizzle(sqlite, { schema });
  }
  return g.__pfDrizzle;
}

/** Reset the cached Drizzle instance (call after lock/close) */
export function resetDb(): void {
  g.__pfDrizzle = null;
}

/**
 * Lazy Proxy — all existing `import { db } from "@/db"` calls continue to work.
 * The real Drizzle instance is created on first property access after unlock.
 */
export const db = new Proxy({} as DrizzleDb, {
  get(_target, prop, receiver) {
    const real = getDb();
    const value = Reflect.get(real, prop, receiver);
    if (typeof value === "function") {
      return value.bind(real);
    }
    return value;
  },
});

export { schema };
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
