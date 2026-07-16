/**
 * FINLYNQ-263 (child A) — toolset-registry assertion.
 *
 * Every registered tool must map to exactly one toolset, and the
 * `import-pipeline` set must have exactly the enumerated 24 members (11 imports
 * + 13 reconcile; get_reconciliation_summary lives in analytics — FINLYNQ-271).
 * This is the tripwire that keeps `src/lib/mcp/toolsets.ts`
 * from drifting from the registered surface — a new reconcile/import tool added
 * without an entry, or a stale entry naming a removed tool, fails here.
 *
 * DB-free (registration only).
 */
import { describe, it, expect, beforeAll } from "vitest";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPgTools } from "../../mcp-server/register-tools-pg";
import { withAutoAnnotations } from "../../mcp-server/auto-annotations";
import {
  toolsetForTool,
  IMPORT_PIPELINE_TOOLS,
  isToolInEnabledToolsets,
  DEFAULT_TOOLSETS,
  type Toolset,
} from "../../src/lib/mcp/toolsets";

function registeredNames(): string[] {
  const server = withAutoAnnotations(
    new McpServer({ name: "toolset-registry-test", version: "0.0.0" }),
  );
  registerPgTools(
    server,
    { execute: async () => ({ rows: [], rowCount: 0 }) },
    "default",
    Buffer.alloc(32),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Object.keys((server as any)._registeredTools as Record<string, unknown>);
}

describe("MCP toolset registry (FINLYNQ-263)", () => {
  let names: string[];
  beforeAll(() => {
    names = registeredNames();
  });

  it("every registered tool maps to exactly one valid toolset", () => {
    const valid: Toolset[] = ["analytics", "ledger-write", "import-pipeline", "admin"];
    for (const name of names) {
      const set = toolsetForTool(name);
      expect(valid, `${name} → ${set}`).toContain(set);
    }
  });

  it("every import-pipeline entry names a REGISTERED tool (no stale entries)", () => {
    const registered = new Set(names);
    const stale = [...IMPORT_PIPELINE_TOOLS].filter((n) => !registered.has(n));
    expect(stale, `stale import-pipeline entries: ${stale.join(", ")}`).toEqual([]);
  });

  it("the live import-pipeline set is exactly the 24 enumerated tools", () => {
    const live = names.filter((n) => toolsetForTool(n) === "import-pipeline").sort();
    const expected = [...IMPORT_PIPELINE_TOOLS].sort();
    expect(live).toEqual(expected);
    expect(expected.length).toBe(24);
  });

  it("get_reconciliation_summary is in the default analytics profile (FINLYNQ-271)", () => {
    expect(toolsetForTool("get_reconciliation_summary")).toBe("analytics");
    expect(IMPORT_PIPELINE_TOOLS.has("get_reconciliation_summary")).toBe(false);
    expect(
      isToolInEnabledToolsets("get_reconciliation_summary", DEFAULT_TOOLSETS),
    ).toBe(true);
    // The write cohort stays gated.
    expect(isToolInEnabledToolsets("upload_statement", DEFAULT_TOOLSETS)).toBe(false);
  });

  it("default toolsets hide import-pipeline but expose analytics + ledger-write", () => {
    const importTool = "upload_statement";
    const analyticsTool = "get_net_worth";
    const ledgerTool = "manage_goals";
    expect(isToolInEnabledToolsets(importTool, DEFAULT_TOOLSETS)).toBe(false);
    expect(isToolInEnabledToolsets(analyticsTool, DEFAULT_TOOLSETS)).toBe(true);
    expect(isToolInEnabledToolsets(ledgerTool, DEFAULT_TOOLSETS)).toBe(true);
  });

  it("the DEFAULT-PROFILE tools/list is <= 60 (tc-1) + import-pipeline hidden", async () => {
    // Owner decision #6: the <= 60 bar is measured against the default profile
    // (analytics + ledger-write), NOT the full registry. The 25 import/reconcile
    // tools are toolset-gated OFF by default.
    const { dumpToolsList } = await import("./eval/dump-tools-list");
    const defProfile = await dumpToolsList((n) =>
      isToolInEnabledToolsets(n, DEFAULT_TOOLSETS),
    );
    expect(defProfile.length).toBeLessThanOrEqual(60);
    const leaked = defProfile
      .map((t) => t.name)
      .filter((n) => IMPORT_PIPELINE_TOOLS.has(n));
    expect(leaked, `import tools in default profile: ${leaked.join(", ")}`).toEqual([]);
  });
});
