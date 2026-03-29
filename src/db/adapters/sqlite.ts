/**
 * SQLite Adapter — wraps the existing SQLCipher connection logic
 * for the self-hosted product.
 *
 * This adapter re-uses the battle-tested connection, encryption,
 * and cloud-sync machinery from connection.ts.
 */

import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../schema";
import {
  initializeConnection as initConn,
  closeConnection as closeConn,
  getConnection,
  isUnlocked,
  isCloudReadOnly,
} from "../connection";
import type {
  DatabaseAdapter,
  DbAdapterConfig,
  DrizzleSqliteDb,
} from "../adapter";

export class SqliteAdapter implements DatabaseAdapter {
  readonly dialect = "sqlite" as const;
  private db: DrizzleSqliteDb | null = null;

  initialize(config: DbAdapterConfig): void {
    if (!config.sqlite) {
      throw new Error("SqliteAdapter requires sqlite config");
    }
    const { passphrase, dbPath, mode } = config.sqlite;
    initConn(passphrase, dbPath, mode);
    this.db = drizzle(getConnection(), { schema });
  }

  getDb(): DrizzleSqliteDb {
    if (!this.db) {
      if (isUnlocked()) {
        this.db = drizzle(getConnection(), { schema });
        return this.db;
      }
      throw new Error("SQLite adapter not initialized. Call initialize() first.");
    }
    return this.db;
  }

  isConnected(): boolean {
    return isUnlocked();
  }

  isReadOnly(): boolean {
    return isCloudReadOnly();
  }

  migrate(): void {
    const db = this.getDb();
    migrate(db, { migrationsFolder: "./drizzle" });
  }

  close(): void {
    closeConn();
    this.db = null;
  }
}
