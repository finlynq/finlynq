/**
 * PostgreSQL-only connection module
 *
 * This file is kept for backward compatibility but connection management
 * is now delegated to the PostgreSQL adapter. These functions are no-ops
 * or throw NotImplementedError for self-hosted mode functions.
 */

export class DatabaseLockedError extends Error {
  constructor() {
    super("Database is locked. This is only applicable in self-hosted SQLite mode.");
    this.name = "DatabaseLockedError";
  }
}

/**
 * Initialize connection (PostgreSQL-only)
 *
 * In PostgreSQL mode, connections are managed through the PostgresAdapter.
 * This function is a no-op for backward compatibility.
 */
export function initializeConnection(
  passphrase: string,
  dbPath?: string,
  mode?: "local" | "cloud"
): void {
  throw new Error(
    "initializeConnection() is not available in PostgreSQL-only mode. Use PostgresAdapter.initialize() instead."
  );
}

/**
 * Get connection (PostgreSQL-only)
 *
 * Not available in PostgreSQL mode. Use getAdapter().getDb() instead.
 */
export function getConnection() {
  throw new Error(
    "getConnection() is not available in PostgreSQL-only mode. Use getAdapter().getDb() instead."
  );
}

export function isUnlocked(): boolean {
  // In PostgreSQL mode, connection state is managed by the adapter
  return false;
}

export function getMode(): "local" | "cloud" {
  // Not applicable in PostgreSQL mode
  return "local";
}

export function getDbPath(): string {
  // Not applicable in PostgreSQL mode
  return "";
}

export function isCloudReadOnly(): boolean {
  // PostgreSQL connections are never read-only
  return false;
}

export function closeConnection(): void {
  // In PostgreSQL mode, use getAdapter().close() instead
}
