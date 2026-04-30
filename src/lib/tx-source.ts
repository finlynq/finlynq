/**
 * Transaction-source enum (issue #28). Set on INSERT, never modified.
 *
 * Each writer surface hard-codes its own source value at the boundary —
 * the deeper helpers take the value as a parameter so attribution is
 * explicit at code-review time. The CHECK constraint in
 * scripts/migrate-tx-audit-fields.sql mirrors the SOURCES tuple below; keep
 * them in lockstep when adding a new source.
 */
export const SOURCES = [
  "manual",
  "import",
  "mcp_http",
  "mcp_stdio",
  "connector",
  "sample_data",
  "backup_restore",
] as const;

export type TransactionSource = (typeof SOURCES)[number];

const SOURCE_SET = new Set<string>(SOURCES);

export function isTransactionSource(v: unknown): v is TransactionSource {
  return typeof v === "string" && SOURCE_SET.has(v);
}

/**
 * Coerce an unknown into a {@link TransactionSource} or fall back to
 * `'backup_restore'`. Used by the backup-restore path where rows from
 * pre-migration backups have no `source` field; we want unknown values
 * (including absent) to land on `backup_restore` rather than silently
 * breaking the CHECK constraint.
 */
export function coerceSourceForRestore(v: unknown): TransactionSource {
  return isTransactionSource(v) ? v : "backup_restore";
}

/** Human-friendly labels for the edit dialog and any future UI. */
export function labelForSource(s: TransactionSource): string {
  switch (s) {
    case "manual":
      return "Manual";
    case "import":
      return "Import";
    case "mcp_http":
      return "MCP (web)";
    case "mcp_stdio":
      return "MCP (CLI)";
    case "connector":
      return "Connector";
    case "sample_data":
      return "Sample data";
    case "backup_restore":
      return "Backup restore";
  }
}
