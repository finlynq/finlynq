/**
 * OAuth scope definitions and scope-based MCP tool filtering.
 *
 * Open #1 from SECURITY_HANDOVER_2026-05-07.md. Until this lands, every OAuth
 * token issued via `/api/oauth/authorize` had implicit `mcp:read mcp:write`
 * scope — the consent screen even said so honestly. This module makes scope
 * an explicit OAuth claim, lets clients request narrower scopes
 * (`scope=mcp:read`), and filters the MCP tool registry per token.
 *
 * Scope strings follow RFC 6749 §3.3 — space-separated tokens. The two
 * recognized tokens at this PR are:
 *
 *   mcp:read   — read-only MCP tools
 *   mcp:write  — destructive / mutating MCP tools (auto-categorize, transfers,
 *                imports, deletes, account/category/holding mutations)
 *
 * Default scope (when a client omits the parameter): `mcp:read mcp:write` —
 * preserves the pre-PR behavior of full access for back-compat with already-
 * registered clients. Migrating clients to narrower scopes is a separate
 * rollout the operator drives by changing the consent-screen default and
 * adding a per-client allowlist if needed.
 *
 * Read-only classification is by NAME PREFIX. Every MCP tool whose name
 * begins with one of READ_PREFIXES is read-only; everything else is treated
 * as a write. The classification is conservative: any tool whose name
 * doesn't match a read prefix is gated behind `mcp:write`, even if the
 * underlying handler happens to be a no-op. This makes adding a new tool
 * impossible to accidentally make accessible to a `mcp:read`-scoped token.
 */

export const SCOPE_MCP_READ = "mcp:read" as const;
export const SCOPE_MCP_WRITE = "mcp:write" as const;
/**
 * FINLYNQ-263 (child A) — the former import-pipeline toolset scope. The
 * import/reconcile cohort was folded into the default-ON `reconcile` /
 * `manage_statement_import` / `manage_bank_ledger` union tools and un-gated
 * (reconcile-consolidation), so this scope no longer enables anything. It stays
 * a VALID token for ONE version (accepted-but-inert) so a client that hardcoded
 * `scope=… mcp:import` in its authorize request doesn't start getting 400s from
 * `normalizeRequestedScope`; it is silently dropped from the canonical scope and
 * grants no extra tools. Remove the token entirely in the next minor.
 */
export const SCOPE_MCP_IMPORT = "mcp:import" as const;
export const DEFAULT_SCOPE = `${SCOPE_MCP_READ} ${SCOPE_MCP_WRITE}`;

const VALID_SCOPE_TOKENS = new Set<string>([
  SCOPE_MCP_READ,
  SCOPE_MCP_WRITE,
  SCOPE_MCP_IMPORT,
]);

/**
 * GH #318 (bug 1) — the `scopes_supported` list published on
 * `/.well-known/oauth-authorization-server` (RFC 8414 §2) and the MCP
 * protected-resource metadata (RFC 9728 §2). Without it a generic client has
 * no way to learn our scopes and falls back to the OIDC defaults
 * (`openid email profile`), which is exactly how #318 started.
 *
 * Deliberately NARROWER than `VALID_SCOPE_TOKENS`: `mcp:import` is still
 * ACCEPTED (so a client that hardcoded it doesn't break) but is no longer
 * ADVERTISED, because it is inert and slated for removal — see the
 * SCOPE_MCP_IMPORT doc comment. Advertising a scope that grants nothing would
 * invite clients to hardcode it right before it disappears.
 *
 * Exported as the single source for both metadata routes; never re-type this
 * array as a literal at a callsite or it will drift when the import scope goes.
 */
export const ADVERTISED_SCOPES: readonly string[] = [
  SCOPE_MCP_READ,
  SCOPE_MCP_WRITE,
];

/**
 * Read-only tool prefixes. Every tool whose name begins with one of these
 * is classified read-only. Anything not matching is treated as a write.
 *
 * Mirrors the inference rules in mcp-server/auto-annotations.ts (in the
 * marketing-analytics-mcp-guide-public branch). Kept in sync explicitly
 * because the two files have different load orders and different consumers
 * (annotations get exported to MCP clients; this list governs what we
 * actually register).
 */
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

/**
 * A handful of read-only tools whose names don't start with one of the
 * READ_PREFIXES. Maintained explicitly so the prefix list stays tight and
 * the "everything else is a write" default holds.
 */
const READ_ONLY_EXACT_NAMES = new Set<string>([
  "finlynq_help",
]);

/** True if the tool is safe to expose under an `mcp:read`-only token. */
export function mcpToolIsReadOnly(toolName: string): boolean {
  if (READ_ONLY_EXACT_NAMES.has(toolName)) return true;
  for (const p of READ_PREFIXES) {
    if (toolName.startsWith(p)) return true;
  }
  return false;
}

/**
 * Parse a stored scope string into a Set of tokens. Returns an empty set
 * for the empty string (which is allowed but unusual — typically scope is
 * NOT NULL DEFAULT 'mcp:read mcp:write' in the DB).
 *
 * Only known tokens are kept; unknown strings are dropped silently. This
 * is the conservative choice — an attacker can't smuggle a future scope
 * (e.g. `mcp:admin`) into a token by registering a malicious client at
 * a point in time where that scope didn't exist; their string won't be
 * recognized when the consumer eventually adds the new scope.
 */
export function parseScope(scopeString: string | null | undefined): Set<string> {
  if (!scopeString) return new Set();
  const out = new Set<string>();
  for (const tok of scopeString.split(/\s+/).filter(Boolean)) {
    if (VALID_SCOPE_TOKENS.has(tok)) out.add(tok);
  }
  return out;
}

/**
 * Validate a client-requested scope string. Returns the canonicalized,
 * deduplicated, sorted scope. Rejects unknown tokens with a typed error so
 * the OAuth handler can surface a 400 invalid_scope.
 *
 * The empty / null / undefined input maps to DEFAULT_SCOPE — clients that
 * don't specify scope get full access (back-compat with pre-PR behavior).
 */
export class InvalidScopeError extends Error {
  constructor(public readonly invalidToken: string) {
    super(`invalid_scope: unknown scope token "${invalidToken}"`);
  }
}

/**
 * True iff `input` is the empty/unspecified scope that `normalizeRequestedScope`
 * maps to `DEFAULT_SCOPE`. Single source of truth for "was the scope defaulted
 * because the client omitted it?" — kept in lockstep with the L1 branch of
 * `normalizeRequestedScope` so the issuance log line (FINLYNQ-163) detects the
 * exact same condition that triggers the default. Pure; no side effects.
 */
export function scopeWasUnspecified(input: string | null | undefined): boolean {
  return input == null || input.trim().length === 0;
}

export function normalizeRequestedScope(input: string | null | undefined): string {
  if (scopeWasUnspecified(input)) return DEFAULT_SCOPE;
  // `scopeWasUnspecified` already excluded null/undefined/whitespace-only, but
  // it returns a plain boolean (so the log-site can call it without a guard),
  // which TS can't use to narrow `input`. The `?? ""` is unreachable — the
  // guard above guarantees a non-empty string here.
  const seen = new Set<string>();
  for (const tok of (input ?? "").split(/\s+/).filter(Boolean)) {
    if (!VALID_SCOPE_TOKENS.has(tok)) {
      throw new InvalidScopeError(tok);
    }
    seen.add(tok);
  }
  if (seen.size === 0) return DEFAULT_SCOPE;
  // Stable order: read first, write second. Lets the DB DEFAULT match exactly
  // for the common case so `scope = 'mcp:read mcp:write'` strings collide.
  // `mcp:import` is deliberately NOT re-emitted — it's accepted-but-inert
  // (validated above so it doesn't 400) and dropped from the canonical scope.
  const ordered: string[] = [];
  if (seen.has(SCOPE_MCP_READ)) ordered.push(SCOPE_MCP_READ);
  if (seen.has(SCOPE_MCP_WRITE)) ordered.push(SCOPE_MCP_WRITE);
  return ordered.join(" ");
}

/**
 * GH #318 (bug 2) — the LENIENT counterpart to `normalizeRequestedScope`:
 * unknown scope tokens are DROPPED instead of throwing `InvalidScopeError`.
 *
 * This is the normalizer the OAuth authorize path uses. The strict one is kept
 * (still exported, still tested) for callers that genuinely want a 400 on an
 * unrecognized token, but it must never gate a generic MCP client: `mcp-remote`
 * — the transport behind Claude Desktop, Cursor, and ChatGPT — requests
 * `openid email profile` when the server publishes no `scopes_supported`, and
 * the strict validator rejected the whole authorize request with
 * `invalid_scope`, killing the connection before login.
 *
 * When NOTHING recognizable survives (`openid email profile` → {}), this falls
 * back to DEFAULT_SCOPE — identical to the omitted-scope branch. That is
 * RFC 6749 §3.3-permitted ("the authorization server MAY fully or partially
 * ignore the scope requested") and §5.1-honest: the token endpoint echoes the
 * GRANTED `scope` back to the client, so nobody is misled about what they got.
 *
 * IMPORTANT: the consent screen must parse scope through this SAME function.
 * It used to hand-roll its own split (`scopeTokens.includes("mcp:write")`),
 * which for `openid email profile` yielded a non-empty token list matching
 * nothing — rendering an EMPTY permissions list while the server granted full
 * read+write. Displayed permissions must always equal granted scope.
 */
export function normalizeRequestedScopeLenient(input: string | null | undefined): string {
  if (scopeWasUnspecified(input)) return DEFAULT_SCOPE;
  const seen = parseScope(input);
  if (seen.size === 0) return DEFAULT_SCOPE;
  // Same stable ordering as the strict normalizer, and `mcp:import` is likewise
  // dropped from the canonical scope (accepted-but-inert).
  const ordered: string[] = [];
  if (seen.has(SCOPE_MCP_READ)) ordered.push(SCOPE_MCP_READ);
  if (seen.has(SCOPE_MCP_WRITE)) ordered.push(SCOPE_MCP_WRITE);
  if (ordered.length === 0) return DEFAULT_SCOPE;
  return ordered.join(" ");
}

/**
 * Decision: should the MCP server register this tool for a request whose
 * token has the given scope set?
 *
 * Read-only tools require either `mcp:read` or `mcp:write` (a write-scoped
 * token still gets read tools — that's the conventional "write implies read"
 * inheritance). Write tools require `mcp:write` strictly.
 *
 * If the scope set is empty (e.g. malformed token row), nothing is exposed.
 */
export function isToolAllowedForScope(toolName: string, scope: Set<string>): boolean {
  if (scope.size === 0) return false;
  if (mcpToolIsReadOnly(toolName)) {
    return scope.has(SCOPE_MCP_READ) || scope.has(SCOPE_MCP_WRITE);
  }
  return scope.has(SCOPE_MCP_WRITE);
}

/**
 * Resolve the enabled session toolsets for a request.
 *
 * Since the import/reconcile cohort was folded into the default-ON union tools
 * (reconcile-consolidation), there is no default-OFF user-facing set left, so
 * every connection gets the same base profile — analytics + ledger-write.
 * Retained (with the `admin` seam) so the MCP route's `isToolInEnabledToolsets`
 * filter has a set to check against for a future reserved cohort.
 *
 * `scope` is unused today (read/write gating happens per-tool via
 * `isToolAllowedForScope`); it is kept in the signature so the route call site
 * and a future scope→toolset bridge stay stable.
 */
export function enabledToolsetsForRequest(
  _scope: Set<string>,
): Set<"analytics" | "ledger-write" | "admin"> {
  return new Set<"analytics" | "ledger-write" | "admin">([
    "analytics",
    "ledger-write",
  ]);
}
