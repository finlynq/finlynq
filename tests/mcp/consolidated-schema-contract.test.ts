/**
 * FINLYNQ-263 (child A) — tc-2 contract test for consolidated `manage_*` tools.
 *
 * Each consolidated tool registers a `z.discriminatedUnion` as its input, which
 * (a) advertises a JSON-Schema `oneOf` in `tools/list` and (b) REJECTS an
 * invalid op+field combination at SCHEMA VALIDATION — before the handler runs.
 * This suite proves both, DB-free:
 *   1. every `manage_*` tool advertises `oneOf` in the rendered tools/list;
 *   2. the SDK's own `validateToolInput` throws on a bad `op` and on a
 *      well-formed op that's MISSING a required field (schema-time rejection),
 *      while a valid payload passes validation.
 *
 * The SDK stores the Zod union and validates each call against it; we reach the
 * registered tool + its schema and exercise `safeParse` directly (the exact
 * check the SDK's `validateToolInput` runs).
 */
import { describe, it, expect, beforeAll } from "vitest";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { registerPgTools } from "../../mcp-server/register-tools-pg";
import { withAutoAnnotations } from "../../mcp-server/auto-annotations";
import { buildFilteredToolsList } from "../../mcp-server/tools/_consolidate";

type RegTool = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema?: any;
};

function buildServer() {
  const server = withAutoAnnotations(
    new McpServer({ name: "consolidated-contract-test", version: "0.0.0" }),
  );
  registerPgTools(
    server,
    { execute: async () => ({ rows: [], rowCount: 0 }) },
    "default",
    Buffer.alloc(32),
  );
  return server;
}

// Consolidated tools registered in Phase 1. `bad` = a payload the schema MUST
// reject (invalid op, or a valid op missing a required field). `good` = a
// minimal valid payload the schema MUST accept.
const CASES: Array<{
  name: string;
  badOp: Record<string, unknown>;
  missingField: Record<string, unknown>;
  good: Record<string, unknown>;
}> = [
  {
    name: "manage_goals",
    badOp: { op: "frobnicate", name: "x" },
    missingField: { op: "add" }, // missing name/type/target_amount
    good: { op: "list" },
  },
  {
    name: "manage_accounts",
    badOp: { op: "nuke", name: "x" },
    missingField: { op: "add", name: "Chq" }, // missing type
    good: { op: "set_mode", accountId: 1, mode: "auto" },
  },
  {
    name: "manage_budgets",
    badOp: { op: "list" }, // no list op on budgets → invalid
    missingField: { op: "set", category: "Food" }, // missing month/amount
    good: { op: "delete", category: "Food", month: "2026-01" },
  },
  {
    name: "manage_fx_overrides",
    badOp: { op: "convert", amount: 1 },
    missingField: { op: "set", from: "USD" }, // missing to/date/rate
    good: { op: "list" },
  },
  {
    name: "manage_categories",
    badOp: { op: "rename", id: 1 },
    missingField: { op: "create", type: "E" }, // missing name
    good: { op: "delete", id: 1 },
  },
  {
    name: "manage_holdings",
    badOp: { op: "move", holding: "x" },
    missingField: { op: "add", name: "VEQT" }, // missing account
    good: { op: "delete", holding: "VEQT" },
  },
  {
    name: "manage_rules",
    badOp: { op: "apply", id: 1 },
    missingField: { op: "create", assign_category: "Food" }, // missing match_payee
    good: { op: "list" },
  },
  {
    name: "manage_subscriptions",
    badOp: { op: "detect" },
    missingField: { op: "update" }, // missing id
    good: { op: "list", include_summary: true },
  },
  {
    name: "manage_loans",
    badOp: { op: "amortize", id: 1 },
    missingField: { op: "add", name: "Mortgage" }, // missing type/principal/rate/start_date
    good: { op: "delete", id: 1 },
  },
];

describe("consolidated manage_* schema contracts (FINLYNQ-263 tc-2)", () => {
  let tools: Record<string, RegTool>;
  let advertised: Map<string, unknown>;

  beforeAll(async () => {
    const server = buildServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools = (server as any)._registeredTools as Record<string, RegTool>;
    // Render tools/list to inspect the advertised inputSchema (oneOf).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handlers = (server.server as any)._requestHandlers as Map<
      string,
      (req: unknown, extra: unknown) => Promise<{ tools: Array<{ name: string; inputSchema: unknown }> }>
    >;
    const listHandler = handlers.get(ListToolsRequestSchema.shape.method.value)!;
    const { tools: list } = await listHandler({ method: "tools/list", params: {} }, {});
    // The route post-processes the SDK list with buildFilteredToolsList, which
    // substitutes the pre-computed oneOf schema for consolidated tools (the SDK
    // itself renders a union input as an empty object). Assert against THAT —
    // it is exactly what clients receive.
    const filtered = buildFilteredToolsList(
      list.map((t) => ({ name: t.name, inputSchema: t.inputSchema })),
      () => true,
    );
    advertised = new Map(filtered.map((t) => [t.name, t.inputSchema]));
  });

  for (const c of CASES) {
    describe(c.name, () => {
      it("advertises a JSON-Schema oneOf in tools/list", () => {
        const schema = advertised.get(c.name) as { oneOf?: unknown[] } | undefined;
        expect(schema, `${c.name} advertised`).toBeTruthy();
        expect(Array.isArray(schema?.oneOf), `${c.name} oneOf`).toBe(true);
      });

      it("rejects an invalid op at schema validation", () => {
        const schema = tools[c.name]?.inputSchema;
        expect(schema, `${c.name} registered with a union input`).toBeTruthy();
        expect(schema.safeParse(c.badOp).success).toBe(false);
      });

      it("rejects a valid op missing a required field", () => {
        const schema = tools[c.name]?.inputSchema;
        expect(schema.safeParse(c.missingField).success).toBe(false);
      });

      it("accepts a well-formed payload", () => {
        const schema = tools[c.name]?.inputSchema;
        expect(schema.safeParse(c.good).success).toBe(true);
      });
    });
  }
});
