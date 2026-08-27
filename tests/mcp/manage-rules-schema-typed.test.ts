/**
 * GH #341 — the advertised `manage_rules` JSON Schema must be STRICTLY TYPED.
 *
 * The `update` op's `conditions`/`actions` were declared `z.unknown()`, which
 * `z.toJSONSchema` renders as a node with only a `description` and NO `type`.
 * Home Assistant's MCP integration (voluptuous_openapi `convert_to_voluptuous`)
 * builds a strict validator from `tools/list` and rejects any untyped node —
 * and one malformed tool aborts the ENTIRE integration, taking all 54 tools
 * offline. The fix reuses the real `ConditionGroup` / `Action` schemas from
 * src/lib/rules/schema.ts (the same ones POST /api/rules validates with), which
 * also advertises the full rule grammar to MCP clients for the first time.
 *
 * This test walks the emitted schema the way HA's converter does: every schema
 * node must carry a structural key (`type`/`enum`/`const`/`oneOf`/`anyOf`/
 * `allOf`/`$ref`/`not`) or be a boolean. Note `additionalProperties: {}` (the
 * empty schema) FAILS this walk — that is deliberate; it is exactly the trap
 * the issue reporter fell into with `z.object({}).passthrough()`.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerRulesTools } from "../../mcp-server/tools/rules";
import { CONSOLIDATED_JSON_SCHEMAS } from "../../mcp-server/tools/_consolidate";
import type { PgToolContext } from "../../mcp-server/tools/_shared";

const STRUCTURAL = ["type", "enum", "const", "oneOf", "anyOf", "allOf", "$ref", "not"];

function collectUntypedNodes(node: unknown, path: string, failures: string[]): void {
  if (typeof node === "boolean") return; // true/false are valid JSON Schemas
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    failures.push(`${path}: not a schema object`);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (!STRUCTURAL.some((k) => k in obj)) {
    failures.push(`${path}: missing type (keys: ${Object.keys(obj).join(",")})`);
  }
  for (const key of ["oneOf", "anyOf", "allOf", "prefixItems"]) {
    const arr = obj[key];
    if (Array.isArray(arr)) arr.forEach((s, i) => collectUntypedNodes(s, `${path}.${key}[${i}]`, failures));
  }
  if (obj.items !== undefined) collectUntypedNodes(obj.items, `${path}.items`, failures);
  if (obj.not !== undefined) collectUntypedNodes(obj.not, `${path}.not`, failures);
  if (obj.additionalProperties !== undefined && typeof obj.additionalProperties !== "boolean") {
    collectUntypedNodes(obj.additionalProperties, `${path}.additionalProperties`, failures);
  }
  for (const defsKey of ["$defs", "definitions"]) {
    const defs = obj[defsKey];
    if (defs && typeof defs === "object") {
      for (const [k, v] of Object.entries(defs as Record<string, unknown>)) {
        collectUntypedNodes(v, `${path}.${defsKey}.${k}`, failures);
      }
    }
  }
  const props = obj.properties;
  if (props && typeof props === "object") {
    for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
      collectUntypedNodes(v, `${path}.properties.${k}`, failures);
    }
  }
}

describe("manage_rules advertised schema is strictly typed (GH #341)", () => {
  let schema: Record<string, unknown> | undefined;

  beforeAll(() => {
    // Registration only wires handlers; none run here, so a stub ctx is fine.
    const server = new McpServer({ name: "gh-341-test", version: "0.0.0" });
    registerRulesTools(server, { db: {}, userId: "test", dek: null } as unknown as PgToolContext);
    schema = CONSOLIDATED_JSON_SCHEMAS.get("manage_rules") as Record<string, unknown> | undefined;
  });

  it("emits a schema at all (z.toJSONSchema did not throw into the silent fallback)", () => {
    // registerManageTool catches a toJSONSchema throw and falls back to the
    // SDK's EMPTY schema — a silent regression this assertion makes loud.
    expect(schema).toBeDefined();
  });

  it("every node in the emitted schema is typed (HA voluptuous-strict walk)", () => {
    const failures: string[] = [];
    collectUntypedNodes(schema, "manage_rules", failures);
    expect(failures).toEqual([]);
  });

  it("the update op advertises the real ConditionGroup / Action grammar", () => {
    const branches = (schema?.oneOf ?? schema?.anyOf) as Array<Record<string, unknown>>;
    const update = branches.find((b) => {
      const op = (b.properties as Record<string, Record<string, unknown>>)?.op;
      return op?.const === "update" || (Array.isArray(op?.enum) && op.enum.includes("update"));
    });
    expect(update).toBeDefined();
    const props = update!.properties as Record<string, Record<string, unknown>>;
    // conditions: the ConditionGroup object — {all: Condition[]}
    expect(props.conditions.type).toBe("object");
    const all = (props.conditions.properties as Record<string, Record<string, unknown>>).all;
    expect(all.type).toBe("array");
    expect(Array.isArray((all.items as Record<string, unknown>).anyOf)).toBe(true);
    // actions: array of the Action discriminated union
    expect(props.actions.type).toBe("array");
    const actionItems = props.actions.items as Record<string, unknown>;
    expect(Array.isArray(actionItems.oneOf ?? actionItems.anyOf)).toBe(true);
  });
});
