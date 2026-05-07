/**
 * Auto-annotation helper for MCP tools.
 *
 * The Anthropic Connectors Directory submission requires every tool to expose
 * `title` and either `readOnlyHint` or `destructiveHint` annotations. We have
 * 90 HTTP / 86 stdio tools across four registration files; rather than touch
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
 *
 * Reorder, cancel, approve, link, apply, execute (non-delete), record, add,
 * create, bulk_*, enqueue_* default to {readOnly:false, destructive:false}.
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

export function inferAnnotations(name: string): ToolAnnotations {
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
    destructiveHint: isDestructive,
    idempotentHint: isIdempotent,
    openWorldHint: false,
  };
}

function toTitle(snake: string): string {
  return snake
    .split("_")
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

const PATCHED = Symbol.for("finlynq.autoAnnotated");

/**
 * Patch a McpServer instance so that every subsequent `server.tool(...)` call
 * gets inferred annotations injected before the handler. Idempotent — calling
 * twice on the same server is a no-op.
 *
 * Supported existing call shapes (the SDK exposes more overloads, but only
 * these are used in this codebase):
 *   tool(name, description, schema, callback)            -> 4-arg form
 *   tool(name, description, callback)                    -> 3-arg form
 *
 * The patched call rewrites these to:
 *   tool(name, description, schema, annotations, callback)
 *   tool(name, description, annotations, callback)
 *
 * Both new shapes are valid SDK overloads.
 */
export function withAutoAnnotations(server: McpServer): McpServer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = server as any;
  if (s[PATCHED]) return server;
  s[PATCHED] = true;

  const original = s.tool.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  s.tool = function patchedTool(...args: any[]) {
    if (args.length < 2 || typeof args[0] !== "string") {
      return original(...args);
    }

    const name = args[0] as string;
    const last = args[args.length - 1];
    if (typeof last !== "function") {
      return original(...args);
    }

    // Detect existing annotations: position N-2 is an object with at least
    // one annotation key. Skip injection if already present.
    if (args.length >= 4) {
      const candidate = args[args.length - 2];
      if (looksLikeAnnotations(candidate)) {
        return original(...args);
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
      return original(args[0], args[1], args[2], annotations, args[3]);
    }

    // tool(name, description, callback)
    if (args.length === 3 && typeof args[1] === "string") {
      return original(args[0], args[1], annotations, args[2]);
    }

    // tool(name, schema, callback) — used by some libraries; insert annotations after schema
    if (
      args.length === 3 &&
      args[1] !== null &&
      typeof args[1] === "object"
    ) {
      return original(args[0], args[1], annotations, args[2]);
    }

    // Fallback: don't risk breaking unknown shapes.
    return original(...args);
  };

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
