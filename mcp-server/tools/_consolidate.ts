/**
 * FINLYNQ-263 (child A) — helpers for CRUD consolidation: discriminated-union
 * `manage_*` tool registration, hidden back-compat aliases, and the filtered
 * `tools/list` builder.
 *
 * A consolidated tool folds a per-verb CRUD family (add/update/delete/list …)
 * into ONE `registerTool` call whose input is a `z.discriminatedUnion` on `op`
 * (or `entry_type` for `portfolio_record_entry`). Per-op handler bodies are
 * lifted VERBATIM from the old 1:1 tools, so response shapes stay byte-identical.
 *
 * ### The SDK / JSON-Schema constraint (verified against @modelcontextprotocol/sdk)
 * The SDK's `tools/list` only knows how to render a raw object shape or a Zod
 * OBJECT schema — a top-level `z.discriminatedUnion` normalizes to `undefined`,
 * so the SDK emits an EMPTY inputSchema for it (fields vanish from tools/list).
 * VALIDATION still runs against the union (the SDK falls back to the raw schema
 * in `validateToolInput`), so a bad op+field combo is rejected at the schema
 * layer (tc-2). To ALSO advertise a proper JSON-Schema `oneOf`, we pre-compute
 * the schema with Zod v4's native `z.toJSONSchema(union)` (which emits `oneOf`
 * with a `const` on the discriminator per branch) and store it in
 * `CONSOLIDATED_JSON_SCHEMAS`. The MCP route's `tools/list` handler
 * (`buildFilteredToolsList`) substitutes that schema for the consolidated tools.
 *
 * ### Aliases (owner decision #1 — hidden aliases for one minor version)
 * Each old tool name is registered as a thin wrapper that injects the
 * discriminator + delegates to the same per-op handler, then recorded in
 * `ALIAS_NAMES` so `buildFilteredToolsList` hides it (callable, but not
 * advertised). Aliases are removed in v4.1.
 *
 * `withAutoAnnotations` already patches BOTH `server.tool` and
 * `server.registerTool` (FINLYNQ-264), so consolidated tools + aliases inherit
 * inferred annotations automatically.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type AnyZod = z.ZodTypeAny;
type ToolResult = { content: Array<{ type: "text"; text: string }> };

/**
 * Pre-computed JSON Schema (`oneOf`) for each consolidated `manage_*` /
 * `portfolio_record_entry` tool, keyed by tool name. Populated at registration
 * time by `registerManageTool`; consumed by `buildFilteredToolsList` to
 * override the (empty) schema the SDK would otherwise emit for a union input.
 *
 * Module-level (the schema is identical across users/sessions).
 */
export const CONSOLIDATED_JSON_SCHEMAS: Map<string, unknown> = new Map();

/**
 * The alias registry — the set of retired tool NAMES that forward to a
 * consolidated tool. `buildFilteredToolsList` consults it to hide aliases from
 * the advertised surface while leaving them callable. Module-level Set (the
 * alias name set is static across all users/sessions; recording twice is a
 * no-op).
 */
export const ALIAS_NAMES: Set<string> = new Set();

// ── FINLYNQ-270: stringified-param coercion for the consolidated unions ──────
//
// Many MCP clients (Claude's included) stringify top-level scalar params, and on
// the 2020-12 `oneOf` schema the consolidated tools advertise, clients that
// can't infer a per-param type across the union stringify EVERYTHING — numbers,
// booleans, even whole JSON arrays/objects (see the FINLYNQ-270 escalation
// matrix). Strict `z.number()` / `z.array()` then reject with -32602, making the
// entire v4 write surface unusable from those clients.
//
// The fix is a SCHEMA-AWARE pre-parse applied ONCE in `registerManageTool`,
// before the `discriminatedUnion` parse: for the variant selected by the
// discriminator, walk each field's declared (unwrapped) type and, when a STRING
// arrived where a non-string was expected, coerce it — number-string → number,
// "true"/"false" → boolean, JSON array/object string → parsed value (recursing
// into the parsed structure). Correctly-typed inputs are passed through
// UNTOUCHED, and anything that can't be coerced (e.g. "" or "abc" for a number)
// is left as-is so the union parse still rejects it with a real validation error
// — no silent 0/NaN writes.
//
// This is deliberately conservative: it never throws (introspection failures
// pass the value through), never touches the discriminator (a literal stays a
// literal), and never coerces a value into a `z.string()` field.

/** Unwrap optional / nullable / default / non-discriminated pipe wrappers to the inner schema + its zod type name. */
function unwrapZod(schema: unknown): { type: string | undefined; schema: unknown } {
  let cur = schema as { _zod?: { def?: { type?: string; innerType?: unknown; in?: unknown } } } | undefined;
  // Bound the loop to avoid any pathological cycle.
  for (let i = 0; i < 10 && cur?._zod?.def; i++) {
    const def = cur._zod.def!;
    const t = def.type;
    if ((t === "optional" || t === "nullable" || t === "default") && def.innerType) {
      cur = def.innerType as typeof cur;
      continue;
    }
    // `z.pipe` (e.g. z.string().pipe(...)) — unwrap to the input schema so we
    // classify by what the caller supplies, not the transform output.
    if (t === "pipe" && def.in) {
      cur = def.in as typeof cur;
      continue;
    }
    return { type: t, schema: cur };
  }
  return { type: cur?._zod?.def?.type, schema: cur };
}

/** Coerce ONE raw value toward the target schema. Returns the (possibly-coerced) value; never throws. */
function coerceValue(raw: unknown, schema: unknown): unknown {
  try {
    const { type, schema: inner } = unwrapZod(schema);
    if (type === "number") {
      if (typeof raw === "string") {
        const trimmed = raw.trim();
        // Only coerce a genuinely numeric string; leave "" / "abc" so the
        // union parse rejects them (no silent 0 / NaN write).
        if (trimmed !== "" && Number.isFinite(Number(trimmed))) return Number(trimmed);
      }
      return raw;
    }
    if (type === "boolean") {
      // z.coerce.boolean treats any non-empty string as true — that footgun is
      // exactly why we DON'T use it. Map the literal tokens explicitly.
      if (typeof raw === "string") {
        const t = raw.trim().toLowerCase();
        if (t === "true") return true;
        if (t === "false") return false;
      }
      return raw;
    }
    if (type === "array") {
      let arr = raw;
      if (typeof raw === "string") {
        const parsed = tryJsonParse(raw);
        if (Array.isArray(parsed)) arr = parsed;
      }
      if (Array.isArray(arr)) {
        // Recurse into elements against the element schema when introspectable.
        const elementSchema = (inner as { _zod?: { def?: { element?: unknown } } })?._zod?.def?.element;
        return elementSchema ? arr.map((el) => coerceValue(el, elementSchema)) : arr;
      }
      return raw;
    }
    if (type === "object") {
      let obj = raw;
      if (typeof raw === "string") {
        const parsed = tryJsonParse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) obj = parsed;
      }
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        const shape = (inner as { _zod?: { def?: { shape?: Record<string, unknown> } } })?._zod?.def?.shape;
        return shape ? coerceShape(obj as Record<string, unknown>, shape) : obj;
      }
      return raw;
    }
    // string / enum / literal / anything else → leave untouched.
    return raw;
  } catch {
    return raw;
  }
}

/** JSON.parse that returns undefined instead of throwing (so callers can guard the shape). */
function tryJsonParse(s: string): unknown {
  const trimmed = s.trim();
  if (!(trimmed.startsWith("[") || trimmed.startsWith("{"))) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** Coerce every field of `obj` against the matching field schema in `shape`. */
function coerceShape(obj: Record<string, unknown>, shape: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...obj };
  for (const key of Object.keys(shape)) {
    if (key in out) out[key] = coerceValue(out[key], shape[key]);
  }
  return out;
}

/**
 * Pre-parse the raw MCP input against a `z.discriminatedUnion`, coercing
 * stringified scalars/arrays/objects toward the schema of the variant selected
 * by the discriminator. Returns the raw input unchanged on any structural
 * surprise (non-object input, missing/unknown discriminator) so the subsequent
 * union parse produces the authoritative validation error. Never throws.
 */
export function coerceUnionInput(union: unknown, raw: unknown): unknown {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const def = (union as { _zod?: { def?: { type?: string; discriminator?: string; options?: unknown[] } } })?._zod?.def;
    if (!def || def.type !== "union") return raw;
    const discriminator = def.discriminator;
    const options = def.options ?? [];
    const rawObj = raw as Record<string, unknown>;
    // Pick the variant whose discriminator literal matches the supplied value.
    // The discriminator itself is NEVER coerced (a literal stays a literal).
    const discVal = discriminator ? rawObj[discriminator] : undefined;
    let shape: Record<string, unknown> | undefined;
    for (const opt of options) {
      const optShape = (opt as { _zod?: { def?: { shape?: Record<string, unknown> } } })?._zod?.def?.shape;
      if (!optShape) continue;
      const litSchema = discriminator ? optShape[discriminator] : undefined;
      const litVal = (litSchema as { _zod?: { def?: { values?: unknown[] } } })?._zod?.def?.values?.[0];
      if (litVal !== undefined && litVal === discVal) {
        shape = optShape;
        break;
      }
    }
    if (!shape) return raw; // unknown/missing discriminator → let the union parse reject.
    const out: Record<string, unknown> = { ...rawObj };
    for (const key of Object.keys(shape)) {
      if (key === discriminator) continue; // never coerce the discriminant.
      if (key in out) out[key] = coerceValue(out[key], shape[key]);
    }
    return out;
  } catch {
    return raw;
  }
}

/**
 * Register a consolidated `manage_*` tool from a discriminated union. The union
 * drives VALIDATION (a bad op+field combo is rejected — tc-2); its native
 * `z.toJSONSchema` `oneOf` is recorded for `tools/list` advertisement.
 *
 * @param server   the McpServer (already auto-annotated)
 * @param name     the consolidated tool name (e.g. "manage_goals")
 * @param description  the tool description (verb-first, distinct first 60 chars)
 * @param union    a `z.discriminatedUnion(...)` over the op/entry_type variants
 * @param handler  receives the validated (narrowed) input; switches on the
 *                 discriminator and returns the per-op result verbatim
 */
export function registerManageTool<U extends AnyZod>(
  server: McpServer,
  name: string,
  description: string,
  union: U,
  handler: (input: z.infer<U>) => Promise<ToolResult>,
): void {
  // Record the native-v4 oneOf JSON schema for tools/list advertisement. Built
  // from the RAW union so the advertised `oneOf` is byte-identical to pre-270
  // (the coercion preprocess below does not change the declared JSON Schema).
  try {
    const jsonSchema = z.toJSONSchema(union) as Record<string, unknown>;
    // MCP requires `inputSchema` to be a JSON-Schema OBJECT (`type: "object"`).
    // Zod renders a `z.discriminatedUnion` as a bare top-level `oneOf` with NO
    // `type`, which spec-strict clients (the Claude Code CLI) reject — and they
    // reject the ENTIRE tools/list, so every consolidated tool disappears. Each
    // union branch is itself an object, so asserting `type: "object"` at the top
    // is semantically sound and spec-compliant. (The claude.ai connector tolerated
    // the missing `type`; the CLI does not.)
    if (jsonSchema && typeof jsonSchema === "object" && jsonSchema.type === undefined) {
      jsonSchema.type = "object";
    }
    CONSOLIDATED_JSON_SCHEMAS.set(name, jsonSchema);
  } catch {
    // If schema generation ever fails, tools/list falls back to the SDK's
    // (empty) rendering — validation is unaffected. Non-fatal.
    CONSOLIDATED_JSON_SCHEMAS.delete(name);
  }
  // FINLYNQ-270: wrap the union in a preprocess that coerces stringified
  // scalars/arrays/objects BEFORE the discriminatedUnion validation the SDK runs
  // in `registerTool`. Validation semantics are unchanged (a bad op+field combo
  // still rejects — tc-2), and `z.toJSONSchema` of the wrapped schema still emits
  // the same `oneOf` — but we advertise the RAW union's schema above anyway.
  const validationSchema = z.preprocess(
    (raw) => coerceUnionInput(union, raw),
    union,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool(
    name,
    { description, inputSchema: validationSchema },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (input: any) => handler(input as z.infer<U>),
  );
}

/**
 * Register a hidden back-compat alias `oldName` that forwards to the same
 * per-op handler as a consolidated tool, taking the OLD raw-shape fields (no
 * discriminator) exactly as the retired tool did — so clients that hardcoded
 * the old name + old args keep working. Hidden from `tools/list` via
 * `ALIAS_NAMES`.
 */
export function registerAlias(
  server: McpServer,
  oldName: string,
  description: string,
  inputSchema: z.ZodRawShape,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any) => Promise<ToolResult>,
): void {
  ALIAS_NAMES.add(oldName);
  server.tool(oldName, description, inputSchema, handler);
}

/** True iff `name` is a hidden back-compat alias (excluded from `tools/list`). */
export function isAliasName(name: string): boolean {
  return ALIAS_NAMES.has(name);
}

/** A single `tools/list` entry (the subset the route re-emits). */
export type ToolsListEntry = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
  annotations?: unknown;
};

/**
 * Build the FILTERED `tools/list` response from a registered server. Replaces
 * the SDK's default list handler at the MCP route so we can:
 *   1. HIDE aliases (`ALIAS_NAMES`) — callable but not advertised (decision #1),
 *   2. GATE by toolset — drop tools whose set isn't enabled for the connection
 *      (`isEnabled(name)` returns false), and
 *   3. SUBSTITUTE the pre-computed `oneOf` JSON schema for consolidated tools
 *      (the SDK would otherwise emit an empty schema for a union input).
 *
 * `isEnabled` is the per-connection toolset predicate (from
 * `isToolInEnabledToolsets` bound to the resolved sets). Passing `() => true`
 * yields the full (alias-hidden, schema-corrected) surface.
 *
 * The SDK's own JSON-Schema rendering is reused for every NON-consolidated tool
 * by reading the already-normalized `inputSchema` off `_registeredTools` via a
 * throwaway list call — but to stay decoupled from SDK internals we instead ask
 * the SDK to render the list ONCE and post-process it.
 */
export function buildFilteredToolsList(
  sdkTools: ToolsListEntry[],
  isEnabled: (name: string) => boolean,
): ToolsListEntry[] {
  const out: ToolsListEntry[] = [];
  for (const t of sdkTools) {
    if (isAliasName(t.name)) continue;
    if (!isEnabled(t.name)) continue;
    const override = CONSOLIDATED_JSON_SCHEMAS.get(t.name);
    out.push(override ? { ...t, inputSchema: override } : t);
  }
  return out;
}
