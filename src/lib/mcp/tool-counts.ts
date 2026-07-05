// Single source of truth for advertised MCP tool counts + server version.
// Update here when tools are added; referenced by marketing/docs copy.
// NOTE (FINLYNQ-263): `http` counts the ADVERTISED surface only — the v4.0
// consolidation registers hidden back-compat aliases (callable, but excluded
// from tools/list), which do NOT count here. Phase 1 folded 6 CRUD families
// (goals/accounts/budgets/fx-overrides/categories/holdings): 117 → 104. Phase 2
// folded rules/subscriptions/loans: 104 → 92.
export const MCP_TOOL_COUNTS = { http: 92, stdio: 93 } as const;
// 3.4.0 (FINLYNQ-264): destructive-tool safety pass — tier-1 deletes
// (delete_transfer / delete_account / delete_portfolio_holding) now require a
// preview→confirmation-token two-step, tier-2 single-row deletes accept an
// optional `expected` echo, and every tool carries readOnly/destructive/
// idempotent annotations verified by a registry assertion. Additive params
// only (no tools added/renamed); the v4.0 cut (sibling A's `manage_*` folds)
// lands separately.
export const MCP_SERVER_VERSION = "3.4.0" as const;

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
