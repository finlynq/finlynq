// Single source of truth for advertised MCP tool counts + server version.
// Update here when tools are added; referenced by marketing/docs copy. The
// prebuild catalog generator (scripts/generate-mcp-tool-catalog.mjs) DERIVES
// these counts by parsing the registration files and FAILS the build on any
// mismatch, so these numbers are machine-verified.
// NOTE: `http` counts the ADVERTISED (registered non-alias) surface. History:
// v4.0 folded the per-verb CRUD families into `manage_*`/`portfolio_record_entry`
// (117 → 75). reconcile-consolidation (v4.1) folds the 24-tool import/reconcile
// cohort into 3 union tools (`reconcile`, `manage_statement_import`,
// `manage_bank_ledger`) — 20 folded + 4 legacy `mcp_uploads` tools DELETED (D-2)
// — and removes ALL v4.0 hidden aliases (D-4, incl. get_loans /
// get_portfolio_performance_v2): 75 − 24 + 3 = 54 advertised. With no aliases
// left, registered == advertised for the first time since v4.0, and the whole
// reconcile cohort is default-ON (default-profile tools/list = 54).
// 2026-11-08: `add_snapshot` removed (55 → 54) — it wrote a table prod no
// longer has, so every call failed; net-worth history is automatic.
export const MCP_TOOL_COUNTS = { http: 54, stdio: 89 } as const;
// 4.1.0 (reconcile-consolidation): the CLEAN BREAK. The statement-import +
// bank-reconcile cohort folds into `reconcile` / `manage_statement_import` /
// `manage_bank_ledger` (op discriminator), un-gated into the default session
// (retiring the `import-pipeline` toolset + `mcp:import` scope +
// `mcp_import_toolset_enabled` setting). The legacy `mcp_uploads` import path is
// removed. This release also removes ALL v4.0 hidden back-compat aliases — any
// caller of a retired name now gets a hard "unknown tool" error. Response shapes
// for every surviving op are byte-identical (only the input envelope gained a
// discriminator). See CHANGELOG for the full old→new migration table.
export const MCP_SERVER_VERSION = "4.1.0" as const;

// Server-level trust posture, sent ONCE per session via the MCP `instructions`
// field (FINLYNQ-266). This replaces the "Bookkeeping only:" disclaimer that
// used to open 15+ individual write-tool descriptions — repeating it per-tool
// wasted the highest-signal opening tokens and, under client-side listing
// truncation (~110 chars), made several tools render as the SAME string.
// Every tool description now opens with a distinct verb-first sentence; this
// statement carries the shared bookkeeping-only caveat for the whole surface.
export const MCP_SERVER_INSTRUCTIONS =
  "Bookkeeping only: Finlynq is a personal-finance TRACKER. Every tool reads or writes entries in " +
  "the user's own Finlynq database and NEVER connects to a real bank or brokerage, places an order, " +
  "or moves real money or crypto. \"Record\"/\"buy\"/\"sell\"/\"transfer\"/\"deposit\"/\"withdraw\" mean writing " +
  "a ledger entry, not executing a real-world financial transaction. Write tools require an unlocked " +
  "DEK (they return HTTP 423 otherwise); read tools tolerate a locked DEK but return null for " +
  "encrypted names. Prefer numeric ids over fuzzy names; ambiguous name matches fail loud rather " +
  "than guessing.";
