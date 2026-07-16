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
    // `account` is now optional (FINLYNQ-267 — pass `account`/`account_id`);
    // `name` stays the unconditionally-required add field.
    missingField: { op: "add", account: "TFSA" }, // missing name
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
  {
    name: "manage_splits",
    badOp: { op: "merge", transaction_id: 1 },
    missingField: { op: "add", transaction_id: 1 }, // missing amount
    good: { op: "list", transaction_id: 1 },
  },
  {
    name: "manage_transactions",
    badOp: { op: "categorize", id: 1 },
    missingField: { op: "update" }, // missing id
    good: { op: "delete", id: 1 },
  },
  {
    name: "manage_transfers",
    badOp: { op: "split", linkId: "x" },
    missingField: { op: "record" }, // missing amount
    good: { op: "delete", linkId: "x" },
  },
  {
    // Phase 4: uses the `entry_type` discriminator (owner decision #5), not `op`.
    name: "portfolio_record_entry",
    badOp: { entry_type: "short", holding: "AAPL" },
    missingField: { entry_type: "buy", holding: "AAPL" }, // missing qty/totalCost
    good: { entry_type: "buy", holding: "AAPL", qty: 10, totalCost: 1900 },
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

// ─── FINLYNQ-270: stringified-param coercion contract (tc-2-coerce-contract) ──
//
// Many MCP clients (Claude's) stringify top-level scalar params; on the 2020-12
// `oneOf` schema they stringify EVERYTHING — numbers, booleans, whole JSON
// arrays. `registerManageTool` now pre-parses the input against the selected
// variant and coerces those strings before the union parse. This block proves,
// against the REAL registered schemas, that:
//   1. a stringified numeric scalar parses AND coerces to a number,
//   2. a native number parses to the identical result (no behavior change),
//   3. empty-string / non-numeric on a number field is STILL rejected (no
//      silent 0/NaN write),
//   4. a stringified boolean coerces to the right boolean (not the z.coerce
//      truthy-string footgun),
//   5. a stringified JSON array coerces to a native array.
type CoerceCase = {
  name: string;
  // A payload with a numeric scalar supplied as a STRING; must parse and the
  // named field must coerce to `expectNumber`.
  numericStringPayload: Record<string, unknown>;
  numericField: string;
  expectNumber: number;
  // The SAME payload with the numeric field as a native number.
  numericTypedPayload: Record<string, unknown>;
  // The SAME payload with the numeric field as "" (must REJECT) and "abc".
  emptyStringPayload: Record<string, unknown>;
  nonNumericPayload: Record<string, unknown>;
  // Optional boolean coercion probe.
  booleanStringPayload?: Record<string, unknown>;
  booleanField?: string;
  expectBoolean?: boolean;
  // Optional stringified-JSON-array probe.
  arrayStringPayload?: Record<string, unknown>;
  arrayField?: string;
  expectArray?: unknown[];
};

const COERCE_CASES: CoerceCase[] = [
  {
    name: "manage_goals",
    numericStringPayload: { op: "update", goal_id: "5", target_amount: "999" },
    numericField: "target_amount",
    expectNumber: 999,
    numericTypedPayload: { op: "update", goal_id: 5, target_amount: 999 },
    emptyStringPayload: { op: "update", goal_id: "5", target_amount: "" },
    nonNumericPayload: { op: "update", goal_id: "5", target_amount: "abc" },
    arrayStringPayload: { op: "update", goal_id: "5", account_ids: "[1,2,3]" },
    arrayField: "account_ids",
    expectArray: [1, 2, 3],
  },
  {
    name: "manage_holdings",
    // The FINLYNQ-267 id fast-path — a stringified holdingId was unusable pre-270.
    numericStringPayload: { op: "update", holdingId: "1115", symbol: "X" },
    numericField: "holdingId",
    expectNumber: 1115,
    numericTypedPayload: { op: "update", holdingId: 1115, symbol: "X" },
    emptyStringPayload: { op: "update", holdingId: "", symbol: "X" },
    nonNumericPayload: { op: "update", holdingId: "abc", symbol: "X" },
  },
  {
    name: "manage_subscriptions",
    // No numeric-only variant is convenient; probe the boolean coercion here.
    numericStringPayload: { op: "list", include_summary: "true" },
    numericField: "__none__",
    expectNumber: NaN,
    numericTypedPayload: { op: "list", include_summary: true },
    emptyStringPayload: { op: "update" }, // missing id → reject (unrelated to numeric)
    nonNumericPayload: { op: "update" },
    booleanStringPayload: { op: "list", include_summary: "false" },
    booleanField: "include_summary",
    expectBoolean: false,
  },
  {
    name: "portfolio_record_entry",
    numericStringPayload: { entry_type: "buy", holding: "AAPL", qty: "10", totalCost: "1900" },
    numericField: "qty",
    expectNumber: 10,
    numericTypedPayload: { entry_type: "buy", holding: "AAPL", qty: 10, totalCost: 1900 },
    emptyStringPayload: { entry_type: "buy", holding: "AAPL", qty: "", totalCost: "1900" },
    nonNumericPayload: { entry_type: "buy", holding: "AAPL", qty: "abc", totalCost: "1900" },
  },
  {
    name: "manage_transactions",
    // Whole JSON array supplied as a string (the escalation-matrix worst case).
    numericStringPayload: { op: "delete", id: "42" },
    numericField: "id",
    expectNumber: 42,
    numericTypedPayload: { op: "delete", id: 42 },
    emptyStringPayload: { op: "delete", id: "" },
    nonNumericPayload: { op: "delete", id: "abc" },
    arrayStringPayload: { op: "record", transactions: '[{"amount":-5,"payee":"X","account":"Chq"}]' },
    arrayField: "transactions",
    expectArray: [{ amount: -5, payee: "X", account: "Chq" }],
  },
];

describe("consolidated tools coerce stringified params (FINLYNQ-270 tc-2)", () => {
  let tools: Record<string, RegTool>;

  beforeAll(() => {
    const server = buildServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools = (server as any)._registeredTools as Record<string, RegTool>;
  });

  for (const c of COERCE_CASES) {
    describe(c.name, () => {
      it("accepts a stringified numeric scalar and coerces it to a number", () => {
        if (c.numericField === "__none__") return;
        const schema = tools[c.name]?.inputSchema;
        const r = schema.safeParse(c.numericStringPayload);
        expect(r.success, `${c.name} stringified numeric`).toBe(true);
        expect((r.data as Record<string, unknown>)[c.numericField]).toBe(c.expectNumber);
      });

      it("parses a native numeric identically (no behavior change)", () => {
        if (c.numericField === "__none__") return;
        const schema = tools[c.name]?.inputSchema;
        const r = schema.safeParse(c.numericTypedPayload);
        expect(r.success, `${c.name} native numeric`).toBe(true);
        expect((r.data as Record<string, unknown>)[c.numericField]).toBe(c.expectNumber);
      });

      it("still REJECTS empty-string / non-numeric on a number field (no silent 0/NaN)", () => {
        if (c.numericField === "__none__") return;
        const schema = tools[c.name]?.inputSchema;
        expect(schema.safeParse(c.emptyStringPayload).success, `${c.name} empty-string`).toBe(false);
        expect(schema.safeParse(c.nonNumericPayload).success, `${c.name} non-numeric`).toBe(false);
      });

      if (c.booleanStringPayload && c.booleanField) {
        it("coerces a stringified boolean to the correct boolean (not truthy-string)", () => {
          const schema = tools[c.name]?.inputSchema;
          const r = schema.safeParse(c.booleanStringPayload);
          expect(r.success, `${c.name} stringified boolean`).toBe(true);
          expect((r.data as Record<string, unknown>)[c.booleanField!]).toBe(c.expectBoolean);
        });
      }

      if (c.arrayStringPayload && c.arrayField) {
        it("coerces a stringified JSON array to a native array", () => {
          const schema = tools[c.name]?.inputSchema;
          const r = schema.safeParse(c.arrayStringPayload);
          expect(r.success, `${c.name} stringified array`).toBe(true);
          expect((r.data as Record<string, unknown>)[c.arrayField!]).toEqual(c.expectArray);
        });
      }
    });
  }
});

// ─── FINLYNQ-282: manage_transfers op=delete `id` alias (tc-2-param-aligned) ──
//
// manage_transactions op=delete takes `id`; manage_transfers op=delete
// historically took only `transactionId`/`linkId`. FINLYNQ-282 adds `id` as an
// accepted alias for `transactionId` on manage_transfers op=delete (transactionId
// wins if both are passed) so the two tools' delete param spellings align, while
// keeping the pre-existing spellings working. This asserts the SCHEMA accepts all
// three spellings (incl. the FINLYNQ-270 stringified-id coercion path).
describe("manage_transfers op=delete accepts the `id` alias (FINLYNQ-282)", () => {
  let tools: Record<string, RegTool>;

  beforeAll(() => {
    const server = buildServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools = (server as any)._registeredTools as Record<string, RegTool>;
  });

  const schemaOf = () => tools["manage_transfers"]?.inputSchema;

  it("accepts op=delete with the new `id` spelling", () => {
    const r = schemaOf().safeParse({ op: "delete", id: 42 });
    expect(r.success, "id spelling").toBe(true);
    expect((r.data as Record<string, unknown>).id).toBe(42);
  });

  it("coerces a stringified `id` to a number (FINLYNQ-270 path)", () => {
    const r = schemaOf().safeParse({ op: "delete", id: "42" });
    expect(r.success, "stringified id").toBe(true);
    expect((r.data as Record<string, unknown>).id).toBe(42);
  });

  it("still accepts the legacy `transactionId` and `linkId` spellings", () => {
    expect(schemaOf().safeParse({ op: "delete", transactionId: 42 }).success).toBe(true);
    expect(schemaOf().safeParse({ op: "delete", linkId: "abc" }).success).toBe(true);
  });
});
