/**
 * Auto-annotation helper for MCP tools.
 *
 * The Anthropic Connectors Directory submission requires every tool to expose
 * `title` and either `readOnlyHint` or `destructiveHint` annotations. The
 * tool count is single-sourced in src/lib/mcp/tool-counts.ts (currently 117
 * HTTP / 93 stdio) across several registration files; rather than touch
 * every callsite, we monkey-patch `server.tool()` once per server instance to
 * inject inferred annotations from the tool name.
 *
 * Annotations are HINTS to clients per the MCP spec; the underlying handler
 * is unchanged. Confirmation-token / preview-execute safety is enforced
 * server-side regardless of the client's interpretation of these hints.
 *
 * Inference rules (by name prefix / contained token):
 *   read-only        get_  list_  find_  search_  analyze_  preview_  test_
 *                    trace_  detect_  convert_  suggest_  describe_  read_
 *                    finlynq_help  *_help
 *   destructive      delete_*   *_delete   reject_*
 *   idempotent       set_*  update_*  replace_*  delete_*  reject_*  + read tools
 *   open-world       false (Finlynq operates only on the user's own DB)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type ToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

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
];

const IDEMPOTENT_WRITE_PREFIXES = ["set_", "update_", "replace_"];

// Read tools that fetch live external prices / FX rates reach an "open world"
// (Yahoo / CoinGecko / Stooq); everything else operates only on the user's
// own database. openWorldHint is advisory per the MCP spec.
const EXTERNAL_WORLD_TOOLS = new Set(["get_fx_rate", "convert_amount"]);

/**
 * Explicit annotation overrides for tools whose NAME escapes the prefix/token
 * inference (FINLYNQ-264). Consulted by `inferAnnotations` before falling back
 * to name inference. Two intended kinds of entry:
 *   - a conditionally-destructive tool whose name lacks a `delete_`/`reject_`/
 *     `_delete` token but which CAN destroy data (the future A-era
 *     `manage_*{op:"delete"}` union tools are the big one);
 *   - a non-idempotent create whose name would otherwise infer wrong.
 *
 * Kept small + greppable, mirroring `tool-counts.ts`. The registry
 * annotation-assertion test (`tests/mcp/annotation-registry.test.ts`) asserts
 * every entry here still names a REGISTERED tool, so a stale key fails CI.
 *
 * NOTE: the pre-existing `replace_splits` / `cancel_import` tools declare their
 * annotations INLINE via the explicit-annotations arg (the `looksLikeAnnotations`
 * escape hatch), so they are intentionally NOT listed here.
 */
export const TOOL_ANNOTATION_OVERRIDES: Record<string, ToolAnnotations> = {
  // FINLYNQ-263 (child A) — consolidated `manage_*` union tools that carry a
  // destructive `op:"delete"` branch but whose NAME escapes the `delete_`/
  // `reject_`/`_delete` inference. Marked destructive so the annotation gate +
  // client hints stay accurate. (`idempotentHint` follows the delete/set
  // semantics; a name-escaping create+delete union is NOT idempotent, so leave
  // it false unless every op is set/delete.)
  // Phase 1 (goals / accounts / budgets / fx-overrides / categories / holdings):
  manage_goals: { destructiveHint: true },
  manage_fx_overrides: { destructiveHint: true },
  manage_categories: { destructiveHint: true },
  manage_accounts: { destructiveHint: true },
  manage_budgets: { destructiveHint: true },
  manage_holdings: { destructiveHint: true },
  // Later phases add manage_rules / manage_subscriptions / manage_loans /
  // manage_transactions / manage_transfers / manage_splits when they register.
};

export function inferAnnotations(name: string): ToolAnnotations {
  // Explicit override wins over name inference (for name-escaping tools).
  const override = TOOL_ANNOTATION_OVERRIDES[name];
  if (override) {
    return {
      title: override.title ?? toTitle(name),
      readOnlyHint: override.readOnlyHint ?? false,
      destructiveHint: override.destructiveHint ?? false,
      idempotentHint: override.idempotentHint ?? false,
      openWorldHint: override.openWorldHint ?? EXTERNAL_WORLD_TOOLS.has(name),
    };
  }

  const isReadOnly =
    READ_PREFIXES.some((p) => name.startsWith(p)) ||
    name === "finlynq_help" ||
    name.endsWith("_help");

  const isDestructive =
    name.startsWith("delete_") ||
    /_delete(_|$)/.test(name) ||
    name.startsWith("reject_");

  const isIdempotent =
    isReadOnly ||
    isDestructive ||
    IDEMPOTENT_WRITE_PREFIXES.some((p) => name.startsWith(p));

  return {
    title: toTitle(name),
    readOnlyHint: isReadOnly,
    // A read-only tool must NEVER also be marked destructive — per the MCP
    // spec destructiveHint is only meaningful when readOnlyHint is false, and
    // the directory's annotation gate rejects a tool that is both. Gating on
    // !isReadOnly stops preview_* tools whose NAME embeds a delete/reject token
    // (preview_bulk_delete, preview_delete_category — both pure reads that only
    // sample + sign a confirmation token) from inheriting a contradictory hint.
    destructiveHint: isDestructive && !isReadOnly,
    idempotentHint: isIdempotent,
    openWorldHint: EXTERNAL_WORLD_TOOLS.has(name),
  };
}

function toTitle(snake: string): string {
  return snake
    .split("_")
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

/**
 * Merge a caller-supplied (possibly PARTIAL) annotations object over the
 * inferred defaults so all three hints + a title are ALWAYS present, while the
 * caller's explicit hints stay authoritative. FINLYNQ-264: the pre-existing
 * inline-annotation tools (`replace_splits`, `cancel_import`,
 * `upsert_balance_anchor`, `accept_reconcile_suggestions`) passed only the
 * hints they cared about via the escape hatch, leaving the others `undefined` —
 * which broke tc-2's "all three hints on every tool" guarantee. Completing the
 * object here fixes that without touching each callsite.
 */
function completeAnnotations(name: string, partial: ToolAnnotations): ToolAnnotations {
  const inferred = inferAnnotations(name);
  return {
    title: partial.title ?? inferred.title,
    readOnlyHint: partial.readOnlyHint ?? inferred.readOnlyHint,
    destructiveHint: partial.destructiveHint ?? inferred.destructiveHint,
    idempotentHint: partial.idempotentHint ?? inferred.idempotentHint,
    openWorldHint: partial.openWorldHint ?? inferred.openWorldHint,
  };
}

const PATCHED = Symbol.for("finlynq.autoAnnotated");

/**
 * Patch a McpServer instance so that every subsequent `server.tool(...)` call
 * gets inferred annotations injected before the handler. Idempotent — calling
 * twice on the same server is a no-op.
 */
export function withAutoAnnotations(server: McpServer): McpServer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = server as any;
  if (s[PATCHED]) return server;
  s[PATCHED] = true;

  // ── server.tool(...) — the legacy positional API (every current tool) ───────
  const originalTool = s.tool.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  s.tool = function patchedTool(...args: any[]) {
    if (args.length < 2 || typeof args[0] !== "string") {
      return originalTool(...args);
    }

    const name = args[0] as string;
    const last = args[args.length - 1];
    if (typeof last !== "function") {
      return originalTool(...args);
    }

    if (args.length >= 4) {
      const candidate = args[args.length - 2];
      if (looksLikeAnnotations(candidate)) {
        // Caller passed explicit (often PARTIAL) annotations — complete the
        // object so all three hints + title are present (tc-2) while keeping
        // the caller's explicit hints authoritative.
        const completed = completeAnnotations(name, candidate as ToolAnnotations);
        const next = [...args];
        next[next.length - 2] = completed;
        return originalTool(...next);
      }
    }

    const annotations = inferAnnotations(name);

    // tool(name, description, schema, callback)
    if (
      args.length === 4 &&
      typeof args[1] === "string" &&
      args[2] !== null &&
      typeof args[2] === "object"
    ) {
      return originalTool(args[0], args[1], args[2], annotations, args[3]);
    }

    // tool(name, description, callback)
    if (args.length === 3 && typeof args[1] === "string") {
      return originalTool(args[0], args[1], annotations, args[2]);
    }

    // tool(name, schema, callback)
    if (
      args.length === 3 &&
      args[1] !== null &&
      typeof args[1] === "object"
    ) {
      return originalTool(args[0], args[1], annotations, args[2]);
    }

    return originalTool(...args);
  };

  // ── server.registerTool(name, config, callback) — the object-config API ─────
  // FINLYNQ-264: sibling A migrates union tools onto `registerTool`, so the
  // annotation guarantee must cover it too. `config.annotations` (if the caller
  // set one) wins; otherwise we inject the inferred/override annotations.
  if (typeof s.registerTool === "function") {
    const originalRegister = s.registerTool.bind(server);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.registerTool = function patchedRegisterTool(...args: any[]) {
      if (
        args.length < 2 ||
        typeof args[0] !== "string" ||
        args[1] === null ||
        typeof args[1] !== "object"
      ) {
        return originalRegister(...args);
      }
      const name = args[0] as string;
      const config = args[1] as { annotations?: ToolAnnotations };
      // Respect a caller-supplied annotations object (escape hatch) but COMPLETE
      // it so all three hints + title are present (tc-2), same as the positional
      // API above.
      const annotations =
        config.annotations && looksLikeAnnotations(config.annotations)
          ? completeAnnotations(name, config.annotations)
          : inferAnnotations(name);
      const next = { ...config, annotations };
      return originalRegister(args[0], next, ...args.slice(2));
    };
  }

  return server;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function looksLikeAnnotations(o: any): boolean {
  if (!o || typeof o !== "object") return false;
  return (
    "readOnlyHint" in o ||
    "destructiveHint" in o ||
    "idempotentHint" in o ||
    "openWorldHint" in o ||
    ("title" in o && typeof o.title === "string" && Object.keys(o).length <= 5)
  );
}
