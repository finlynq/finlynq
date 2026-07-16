/**
 * MCP session-scoped toolsets (FINLYNQ-263, child A of the MCP-surface-v4 epic).
 *
 * Most sessions never touch the import/reconcile pipeline; exposing all ~68
 * tools in every session degrades LLM tool-selection and can exceed some host
 * tool-caps. This module tags each tool with a `toolset` and lets the MCP
 * server expose only the sets a given connection is entitled to.
 *
 * Sets:
 *   - `analytics`       — all read tools (default-ON).
 *   - `ledger-write`    — record/update/delete ledger + portfolio + config
 *                         writes (default-ON).
 *   - `import-pipeline` — the statement-import + bank-reconcile cohort (the 11
 *                         imports + 13 reconcile tools). Default-OFF; surfaced
 *                         on demand via the `mcp:import` OAuth scope or a
 *                         connection-level setting (see oauth-scopes.ts).
 *                         `get_reconciliation_summary` was LIFTED OUT of this
 *                         set into `analytics` (FINLYNQ-271) so a default-profile
 *                         agent can discover reconcile state + surface an
 *                         `enableHint` prompting the user to grant `mcp:import`.
 *   - `admin`           — reserved (no user-facing connector tools today).
 *
 * SINGLE SOURCE OF TRUTH: the `import-pipeline` set is enumerated EXPLICITLY
 * below (it's the small, stable, invariant-dense cohort). Everything else is
 * derived by name: read tools → `analytics`, all other writes → `ledger-write`.
 * A registry test (`tests/mcp/toolset-registry.test.ts`) asserts every
 * registered tool maps to exactly one set and that the import-pipeline set has
 * exactly the expected members, so this map can't silently drift from the
 * registered surface.
 *
 * Read-only classification mirrors auto-annotations.ts / oauth-scopes.ts — kept
 * in sync via the shared `READ_PREFIXES` semantics (duplicated here to avoid a
 * server↔lib import cycle, same rationale as oauth-scopes.ts).
 */

export type Toolset = "analytics" | "ledger-write" | "import-pipeline" | "admin";

/**
 * The default-ON sets. A connection with no explicit toolset entitlement sees
 * exactly these — analytics + basic ledger-write. `import-pipeline` is added
 * only when the connection opts in (scope `mcp:import` or the connection
 * setting).
 */
export const DEFAULT_TOOLSETS: ReadonlySet<Toolset> = new Set<Toolset>([
  "analytics",
  "ledger-write",
]);

/**
 * The statement-import + bank-reconcile cohort. These 24 tools (11 imports + 13
 * reconcile, FINLYNQ-150/207/208/213–221) are the newest, most invariant-dense
 * write tools; A leaves them 1:1 and gates them behind this set rather than
 * folding them. Enumerated explicitly — a name-only heuristic can't tell
 * `apply_rules_to_bank_rows` (import-pipeline) from `apply_rules_to_uncategorized`
 * (ledger-write), and most reconcile reads (`get_reconcile_suggestions`) belong
 * with their cohort, not with `analytics`.
 *
 * EXCEPTION (FINLYNQ-271): `get_reconciliation_summary` is deliberately NOT in
 * this set — it is a cheap read-only portfolio-wide health call that lives in
 * the default `analytics` profile so an agent can discover reconcile state
 * before any `mcp:import` grant (and its response carries an `enableHint`
 * pointing the user at the grant when the write cohort is still gated).
 */
export const IMPORT_PIPELINE_TOOLS: ReadonlySet<string> = new Set<string>([
  // imports.ts (11)
  "list_pending_uploads",
  "preview_import",
  "execute_import",
  "cancel_import",
  "list_staged_imports",
  "get_staged_import",
  "list_staged_transactions",
  "update_staged_transaction",
  "link_staged_transfer_pair",
  "approve_staged_rows",
  "reject_staged_import",
  // reconcile.ts (13) — get_reconciliation_summary intentionally omitted (→ analytics, FINLYNQ-271)
  "get_reconcile_suggestions",
  "find_duplicate_bank_rows",
  "delete_bank_transaction",
  "get_balance_anchors",
  "upsert_balance_anchor",
  "materialize_bank_row",
  "send_to_bank_ledger",
  "upload_statement",
  "accept_reconcile_suggestion",
  "accept_reconcile_suggestions",
  "unlink_reconcile",
  "apply_rules_to_staged_import",
  "apply_rules_to_bank_rows",
]);

const READ_PREFIXES = [
  "get_",
  "list_",
  "find_",
  "search_",
  "analyze_",
  "preview_",
  "test_",
  "trace_",
  "detect_",
  "convert_",
  "suggest_",
  "describe_",
  "read_",
] as const;

const READ_ONLY_EXACT_NAMES = new Set<string>(["finlynq_help"]);

function isReadOnlyName(name: string): boolean {
  if (READ_ONLY_EXACT_NAMES.has(name)) return true;
  if (name.endsWith("_help")) return true;
  return READ_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * The toolset a given tool belongs to. Precedence:
 *   1. explicit import-pipeline membership,
 *   2. read tools → analytics,
 *   3. everything else → ledger-write.
 *
 * Pure + total: every tool name maps to exactly one set.
 */
export function toolsetForTool(name: string): Toolset {
  if (IMPORT_PIPELINE_TOOLS.has(name)) return "import-pipeline";
  if (isReadOnlyName(name)) return "analytics";
  return "ledger-write";
}

/**
 * Decision: should the MCP server register `toolName` for a connection entitled
 * to `enabled` toolsets? A tool is exposed iff its set is enabled.
 */
export function isToolInEnabledToolsets(
  toolName: string,
  enabled: ReadonlySet<Toolset>,
): boolean {
  return enabled.has(toolsetForTool(toolName));
}
