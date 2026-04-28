/**
 * Database Adapter Interface
 *
 * Abstracts the database connection lifecycle for PostgreSQL.
 *
 * The adapter handles:
 *  - Connection initialization and teardown
 *  - Returning a Drizzle ORM instance for queries
 *  - Running migrations
 *  - Read-only mode detection
 */

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as pgSchema from "./schema-pg";

/** Drizzle database instance for PostgreSQL */
export type DrizzlePgDb = NodePgDatabase<typeof pgSchema>;
export type DrizzleDb = DrizzlePgDb;

/** Supported database dialects (PostgreSQL only) */
export type DbDialect = "postgres";

/** Configuration for initializing a database adapter */
export interface DbAdapterConfig {
  dialect: DbDialect;

  /** PostgreSQL-specific options */
  postgres?: {
    connectionString: string;
    /** User ID to scope all queries (multi-tenant) */
    userId: string;
    /** Max connections in pool (default: 10) */
    poolSize?: number;
  };
}

/** Database adapter interface — implemented by PostgreSQL */
export interface DatabaseAdapter {
  /** Which dialect this adapter handles */
  readonly dialect: DbDialect;

  /** Initialize the connection (connect to server) */
  initialize(config: DbAdapterConfig): Promise<void> | void;

  /** Return the Drizzle ORM instance for queries */
  getDb(): DrizzleDb;

  /** Whether the adapter has an active connection */
  isConnected(): boolean;

  /** Whether the connection is read-only */
  isReadOnly(): boolean;

  /** Run pending migrations */
  migrate(): Promise<void> | void;

  /** Close the connection and clean up resources */
  close(): Promise<void> | void;
}

/** Default user ID for self-hosted single-user mode */
export const DEFAULT_USER_ID = "default";
