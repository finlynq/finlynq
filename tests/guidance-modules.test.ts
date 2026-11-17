/**
 * FINLYNQ-219: the Finlynq guide modules (src/lib/guides) are the general half
 * of the AI guidance library. Adding a module is one file plus one line in the
 * registry, and every surface (finlynq_help, get_guidance, Settings → AI
 * guidance) reads the registry. These checks keep that true.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import {
  GUIDE_MODULES,
  GUIDE_MODULE_IDS,
  GUIDE_MODULE_MAX_TOKENS,
  estimateTokens,
  findGuideModule,
} from "@/lib/guides/registry";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Every HTTP MCP tool name, read from the registration files. */
function registeredHttpTools(): Set<string> {
  const names = new Set<string>();
  const dir = join(ROOT, "mcp-server", "tools");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(dir, f), "utf8");
    for (const m of src.matchAll(/server\.tool\(\s*"([a-z_]+)"/g)) names.add(m[1]);
    for (const m of src.matchAll(/registerManageTool\(\s*server,\s*"([a-z_]+)"/g)) names.add(m[1]);
  }
  return names;
}

describe("guide module registry", () => {
  it("lists every file in modules/, once", () => {
    const files = readdirSync(join(ROOT, "src", "lib", "guides", "modules")).filter((f) => f.endsWith(".ts"));
    const ids = files.map((f) => {
      const m = /id:\s*"([a-z0-9-]+)"/.exec(read(`src/lib/guides/modules/${f}`));
      return m?.[1];
    });
    expect(ids.every(Boolean)).toBe(true);
    expect([...GUIDE_MODULE_IDS].sort()).toEqual([...(ids as string[])].sort());
    expect(new Set(GUIDE_MODULE_IDS).size).toBe(GUIDE_MODULE_IDS.length);
  });

  it("every module has its fields and stays under the size cap", () => {
    for (const m of GUIDE_MODULES) {
      expect(m.id).toMatch(/^[a-z0-9-]+$/);
      expect(m.title.trim().length).toBeGreaterThan(0);
      expect(m.summary.trim().length).toBeGreaterThan(0);
      expect(m.summary).not.toContain("\n");
      expect(Number.isFinite(m.order)).toBe(true);
      expect(estimateTokens(m.markdown)).toBeLessThanOrEqual(GUIDE_MODULE_MAX_TOKENS);
    }
  });

  it("ships the four first modules, in order", () => {
    expect(GUIDE_MODULE_IDS).toEqual(["reconcile", "portfolio", "loans", "budgeting"]);
  });

  it("names only tools that are registered today", () => {
    const tools = registeredHttpTools();
    expect(tools.has("manage_statement_import")).toBe(true); // the parser works
    const looksLikeTool = /^(get|manage|reconcile|portfolio|analyze|trace|suggest|test|search|finlynq|preview|execute)(_[a-z]+)*$/;
    for (const m of GUIDE_MODULES) {
      for (const span of m.markdown.matchAll(/`([^`]+)`/g)) {
        const name = span[1].split("(")[0].trim();
        if (looksLikeTool.test(name) && name.includes("_")) {
          expect(tools.has(name), `${m.id} mentions ${name}`).toBe(true);
        }
      }
    }
  });

  it("the reconcile guide carries the glossary the original ticket asked for", () => {
    const md = findGuideModule("reconcile")!.markdown;
    expect(md).toContain("seenCount");
    expect(md).toMatch(/not a sign of duplicates/);
    expect(md).toMatch(/importHash.*plain-text payee/);
    expect(md).toMatch(/one per account per day/);
    expect(md).toContain("## Common causes of a mismatch");
    // No pre-v4.1 tool names.
    for (const old of ["upload_statement", "get_reconcile_suggestions", "find_duplicate_bank_rows", "accept_reconcile_suggestion", "materialize_bank_row"]) {
      expect(md).not.toContain(old);
    }
  });
});

describe("finlynq_help and get_guidance read the registry", () => {
  it("HTTP finlynq_help derives its topics from the registry and serves module Markdown", () => {
    const src = read("mcp-server/tools/reads.ts");
    expect(src).toContain("...GUIDE_MODULE_IDS");
    expect(src).toContain("findGuideModule(t)");
    // The old hand-written workflow topics are gone.
    expect(src).not.toContain("phase_1_ingest");
    expect(src).not.toContain('if (t === "reconcile")');
  });

  it("stdio finlynq_help serves the same modules", () => {
    const src = read("mcp-server/register-core-tools.ts");
    expect(src).toContain("...GUIDE_MODULE_IDS");
    expect(src).toContain("findGuideModule(t)");
  });

  it("a topic enum built from the registry is a typed enum (strict clients)", () => {
    const schema = z.toJSONSchema(z.object({ topic: z.enum(["tools", ...GUIDE_MODULE_IDS] as [string, ...string[]]) })) as unknown as {
      properties: { topic: { type: string; enum: string[] } };
    };
    expect(schema.properties.topic.type).toBe("string");
    expect(schema.properties.topic.enum).toEqual(expect.arrayContaining(GUIDE_MODULE_IDS));
  });

  it("the guidance tools are registered, counted and annotated", () => {
    expect(read("mcp-server/register-tools-pg.ts")).toContain("registerGuidanceTools(server, ctx)");
    expect(read("scripts/generate-mcp-tool-catalog.mjs")).toContain('"guidance",');
    expect(read("mcp-server/auto-annotations.ts")).toContain("manage_guidance_notes: { destructiveHint: true }");
    expect(read("src/lib/mcp/tool-counts.ts")).toContain("get_guidance");
  });

  it("the phone reads the same guides from GET /api/guidance/guides", () => {
    const route = read("src/app/api/guidance/guides/route.ts");
    expect(route).toContain('from "@/lib/guides/registry"');
    expect(route).toMatch(/GUIDE_MODULES\.map\(/);
    expect(route).toMatch(/apiHandler\(\{ auth: "auth" \}/);
  });
});
