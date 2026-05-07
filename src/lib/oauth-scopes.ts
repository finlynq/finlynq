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
export const DEFAULT_SCOPE = `${SCOPE_MCP_READ} ${SCOPE_MCP_WRITE}`;

const VALID_SCOPE_TOKENS = new Set<string>([SCOPE_MCP_READ, SCOPE_MCP_WRITE]);

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

export function normalizeRequestedScope(input: string | null | undefined): string {
  if (input == null || input.trim().length === 0) return DEFAULT_SCOPE;
  const seen = new Set<string>();
  for (const tok of input.split(/\s+/).filter(Boolean)) {
    if (!VALID_SCOPE_TOKENS.has(tok)) {
      throw new InvalidScopeError(tok);
    }
    seen.add(tok);
  }
  if (seen.size === 0) return DEFAULT_SCOPE;
  // Stable order: read first, write second. Lets the DB DEFAULT match exactly
  // for the common case so `scope = 'mcp:read mcp:write'` strings collide.
  const ordered: string[] = [];
  if (seen.has(SCOPE_MCP_READ)) ordered.push(SCOPE_MCP_READ);
  if (seen.has(SCOPE_MCP_WRITE)) ordered.push(SCOPE_MCP_WRITE);
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
