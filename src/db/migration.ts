// SQLite migration utilities (disabled in PostgreSQL-only open-source mode)
// This file is kept for compatibility but the functions are no-ops

export type DbState = "missing" | "unencrypted" | "encrypted";

export function detectDbState(dbPath: string): DbState {
  return "missing";
}

export function migrateToEncrypted(
  dbPath: string,
  passphrase: string,
  salt: Buffer
): void {
  // No-op in PostgreSQL-only mode
}
