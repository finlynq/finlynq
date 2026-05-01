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

// ─── Format tags (issue #62) ──────────────────────────────────────────────────
//
// Tag vocabulary written into the comma-separated `transactions.tags` column
// as `source:<format>` to mark which file/wire format the row entered through.
// One of these values per row at most.
//
// **Distinct from `SOURCES` above.** The `transactions.source` audit column
// (above) is the writer-surface enum (`manual` / `import` / `mcp_http` / …).
// `FORMAT_TAGS` is a tag prefix for the import file shape — a CSV upload and
// an Excel upload both have `source='import'` in the audit column but
// different `source:csv` / `source:excel` tags. A future "WealthPosition CSV"
// connector and a "raw bank CSV" upload would both use `source:csv` here even
// though the audit column distinguishes them as `connector` vs `import`.
//
// Kept in this file so future contributors see both tuples side-by-side and
// don't conflate them. The two are independent — adding a new format tag does
// NOT require an audit-column migration and vice-versa.
//
// The `@finlynq/import-connectors` workspace package mirrors this list in
// `packages/import-connectors/src/types.ts`. Keep both in sync.
export const FORMAT_TAGS = [
  "csv",
  "excel",
  "pdf",
  "ofx",
  "qfx",
  "ibkr-xml",
  "email",
] as const;

export type FormatTag = (typeof FORMAT_TAGS)[number];

const FORMAT_TAG_SET = new Set<string>(FORMAT_TAGS);

export function isFormatTag(v: unknown): v is FormatTag {
  return typeof v === "string" && FORMAT_TAG_SET.has(v);
}

/** Render a format tag as the literal string written into `transactions.tags`. */
export function sourceTagFor(format: FormatTag): string {
  return `source:${format}`;
}
