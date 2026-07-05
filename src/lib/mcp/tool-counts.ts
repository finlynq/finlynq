// Single source of truth for advertised MCP tool counts + server version.
// Update here when tools are added; referenced by marketing/docs copy.
// NOTE (FINLYNQ-263): `http` counts the ADVERTISED surface only — the v4.0
// consolidation registers hidden back-compat aliases (callable, but excluded
// from tools/list), which do NOT count here. Phase 1 folded 6 CRUD families
// (goals/accounts/budgets/fx-overrides/categories/holdings): 117 → 104. Phase 2
// folded rules/subscriptions/loans: 104 → 92. Phase 3 folded splits/transactions/
// transfers: 92 → 83. Phase 4 folded the 8 portfolio_* writers into
// portfolio_record_entry (entry_type union; add_snapshot stays standalone): 83 → 76.
// FINLYNQ-265 (child C): get_loans retired from the advertised list (hidden alias
// of list_loans, still callable): 76 → 75. get_portfolio_performance_v2 → renamed
// get_portfolio_returns (old name a hidden alias) is net-0 advertised.
export const MCP_TOOL_COUNTS = { http: 75, stdio: 93 } as const;
// 4.0.0 (FINLYNQ-263): MCP surface v4 — CRUD consolidation + session-scoped
// toolsets. The 117 per-verb HTTP tools collapse into discriminated-union
// `manage_*` tools (op discriminator) + `portfolio_record_entry` (entry_type),
// dropping the ADVERTISED surface to 76 (default-profile tools/list = 51, ≤ 60);
// the 25 import/reconcile tools are toolset-gated OFF by default. Every retired
// name (`add_goal`, `record_transaction`, `portfolio_buy`, …) stays a HIDDEN
// back-compat alias — callable but not advertised — for one minor version
// (removed in v4.1). Response shapes are byte-identical (only the input envelope
// gained a discriminator). See CHANGELOG for the full old→new migration table.
export const MCP_SERVER_VERSION = "4.0.0" as const;

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
