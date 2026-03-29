/**
 * Database Adapter Interface
 *
 * Abstracts the database connection lifecycle so both SQLite (self-hosted)
 * and PostgreSQL (managed hosted) share the same data access layer.
 *
 * The adapter handles:
 *  - Connection initialization and teardown
 *  - Returning a Drizzle ORM instance for queries
 *  - Running migrations
 *  - Read-only mode detection
 */

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as sqliteSchema from "./schema";
import type * as pgSchema from "./schema-pg";

/** Union of Drizzle database instances across supported dialects */
export type DrizzleSqliteDb = BetterSQLite3Database<typeof sqliteSchema>;
export type DrizzlePgDb = NodePgDatabase<typeof pgSchema>;
export type DrizzleDb = DrizzleSqliteDb | DrizzlePgDb;

/** Supported database dialects */
export type DbDialect = "sqlite" | "postgres";

/** Configuration for initializing a database adapter */
export interface DbAdapterConfig {
  dialect: DbDialect;

  /** SQLite-specific options */
  sqlite?: {
    passphrase: string;
    dbPath?: string;
    mode?: "local" | "cloud";
  };

  /** PostgreSQL-specific options */
  postgres?: {
    connectionString: string;
    /** User ID to scope all queries (multi-tenant) */
    userId: string;
    /** Max connections in pool (default: 10) */
    poolSize?: number;
  };
}

/** Database adapter interface — implemented by each dialect */
export interface DatabaseAdapter {
  /** Which dialect this adapter handles */
  readonly dialect: DbDialect;

  /** Initialize the connection (open file / connect to server) */
  initialize(config: DbAdapterConfig): Promise<void> | void;

  /** Return the Drizzle ORM instance for queries */
  getDb(): DrizzleDb;

  /** Whether the adapter has an active connection */
  isConnected(): boolean;

  /** Whether the connection is read-only (e.g. cloud-locked SQLite) */
  isReadOnly(): boolean;

  /** Run pending migrations */
  migrate(): Promise<void> | void;

  /** Close the connection and clean up resources */
  close(): Promise<void> | void;
}

/** Default user ID for self-hosted single-user mode */
export const DEFAULT_USER_ID = "default";
