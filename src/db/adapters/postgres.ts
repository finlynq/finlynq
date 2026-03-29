/**
 * PostgreSQL Adapter — for the managed hosted product.
 *
 * Uses node-postgres (pg) connection pool with Drizzle ORM.
 * All queries are scoped to a user_id for multi-tenant isolation.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "../schema-pg";
import type {
  DatabaseAdapter,
  DbAdapterConfig,
  DrizzlePgDb,
} from "../adapter";

export class PostgresAdapter implements DatabaseAdapter {
  readonly dialect = "postgres" as const;
  private pool: pg.Pool | null = null;
  private db: DrizzlePgDb | null = null;
  private _userId: string = "";

  /** The user_id that all queries should be scoped to */
  get userId(): string {
    return this._userId;
  }

  async initialize(config: DbAdapterConfig): Promise<void> {
    if (!config.postgres) {
      throw new Error("PostgresAdapter requires postgres config");
    }

    const { connectionString, userId, poolSize } = config.postgres;
    this._userId = userId;

    this.pool = new pg.Pool({
      connectionString,
      max: poolSize ?? 10,
    });

    this.db = drizzle(this.pool, { schema });
  }

  getDb(): DrizzlePgDb {
    if (!this.db) {
      throw new Error(
        "PostgreSQL adapter not initialized. Call initialize() first."
      );
    }
    return this.db;
  }

  isConnected(): boolean {
    return this.pool !== null && this.db !== null;
  }

  isReadOnly(): boolean {
    // Managed hosted is never read-only (no cloud-lock concept)
    return false;
  }

  async migrate(): Promise<void> {
    const db = this.getDb();
    await migrate(db, { migrationsFolder: "./drizzle-pg" });
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.db = null;
    }
  }
}
