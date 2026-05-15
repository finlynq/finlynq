#!/usr/bin/env node
/**
 * Generates pf-app/src/app/mcp-guide/tools/tools.generated.ts from the MCP
 * server registration files. Source-of-truth = the TS code in
 * mcp-server/register-tools-pg.ts (HTTP surface) plus the three stdio
 * registration files (used to tag transport availability).
 *
 * Run automatically as a prebuild step. Output is checked in so the public
 * catalog page never goes stale even if the generator fails on a future build.
 *
 * No external deps. Pure regex over the source files — handles both single-
 * line (`server.tool("name", "desc", schema, handler)`) and multi-line
 * (`server.tool(\n  "name",\n  "description ...",\n  schema,\n  async ...\n)`)
 * registration shapes. The two-argument annotation form is not used in our
 * codebase (auto-annotations.ts injects them by monkey-patch at runtime).
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const HTTP_FILE = join(REPO_ROOT, "mcp-server", "register-tools-pg.ts");
const STDIO_FILES = [
  join(REPO_ROOT, "mcp-server", "register-core-tools.ts"),
  join(REPO_ROOT, "mcp-server", "tools-v2.ts"),
  join(REPO_ROOT, "mcp-server", "tools-import-templates.ts"),
];

const OUTPUT_FILE = join(
  REPO_ROOT,
  "src",
  "app",
  "mcp-guide",
  "tools",
  "tools.generated.ts"
);

// Read-prefix list mirrors mcp-server/auto-annotations.ts — keep in sync.
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

/**
 * Parses every `server.tool("name", "description", ...)` call out of a TS
 * source file. Returns an array of `{ name, description }`. Description
 * unescapes \\n, \\", and \\\\ so the rendered text reads cleanly in HTML.
 */
function extractTools(source) {
  // Match name + description as the first two string-literal arguments.
  // Description can be ", ', or `; inner content allows any escape but not
  // the same outer quote. We're conservative about template-literal interpolations
  // — none of our registrations use ${...}, so a flat regex is fine.
  const re =
    /server\.tool\(\s*['"]([a-zA-Z_0-9]+)['"]\s*,\s*(["'`])((?:\\.|(?!\2).)*)\2/g;
  const out = [];
  let m;
  while ((m = re.exec(source))) {
    const name = m[1];
    let desc = m[3];
    // Unescape the standard JS string escapes used in our source.
    desc = desc
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\`/g, "`")
      .replace(/\\\\/g, "\\");
    out.push({ name, description: desc });
  }
  return out;
}

/**
 * Inferred category from the tool name. Mirrors auto-annotations.ts but
 * exposed as a user-facing label rather than a hint flag. The shape ordering
 * is meaningful: destructive checked first so `delete_*` rules win over
 * the read-only `preview_*`/`test_*` heuristics.
 */
function categorize(name) {
  if (
    name.startsWith("delete_") ||
    /_delete(_|$)/.test(name) ||
    name.startsWith("reject_") ||
    name === "cancel_import"
  )
    return "destructive";
  if (name.startsWith("preview_")) return "preview";
  if (name.startsWith("execute_")) return "execute";
  if (name.startsWith("analyze_") || name === "trace_holding_quantity")
    return "analyze";
  if (name.startsWith("get_") || name.startsWith("list_")) return "read";
  if (
    name.startsWith("search_") ||
    name.startsWith("find_") ||
    name.startsWith("detect_") ||
    name.startsWith("test_") ||
    name.startsWith("suggest_") ||
    name.startsWith("convert_") ||
    name.startsWith("read_") ||
    name === "finlynq_help"
  )
    return "read";
  // Everything else writes.
  return "write";
}

function isReadOnly(name) {
  return (
    READ_PREFIXES.some((p) => name.startsWith(p)) ||
    name === "finlynq_help" ||
    name.endsWith("_help")
  );
}

function isDestructive(name) {
  return (
    name.startsWith("delete_") ||
    /_delete(_|$)/.test(name) ||
    name.startsWith("reject_")
  );
}

function isIdempotent(name) {
  return (
    isReadOnly(name) ||
    isDestructive(name) ||
    IDEMPOTENT_WRITE_PREFIXES.some((p) => name.startsWith(p))
  );
}

function requiresWriteScope(name) {
  // Mirrors src/app/api/mcp/route.ts scope gating: anything that isn't
  // read-only requires `mcp:write`.
  return !isReadOnly(name);
}

/**
 * First sentence of the description, lightly cleaned for the catalog blurb.
 * Strips inline issue-reference noise ("Issue #210:" / "Issue #237 —") from
 * the head so the catalog reads as a product page, not a changelog.
 */
function firstSentence(desc) {
  let s = desc.trim().replace(/\s+/g, " ");
  // Cut at the first period that ends a sentence (followed by space or EOL),
  // but keep abbreviations like "e.g." intact by requiring 2+ chars after.
  const m = s.match(/^(.*?[.!?])(\s+[A-Z]|\s*$)/);
  if (m) s = m[1];
  // Strip leading "[DEPRECATED — use foo]" marker for the blurb; the
  // deprecated flag is surfaced separately.
  s = s.replace(/^\[DEPRECATED[^\]]*\]\s*/, "");
  return s.trim();
}

function isDeprecated(desc) {
  return /\[DEPRECATED/i.test(desc) || /^\s*Deprecated\b/i.test(desc);
}

function main() {
  const httpSrc = readFileSync(HTTP_FILE, "utf8");
  const httpTools = extractTools(httpSrc);

  const stdioNames = new Set();
  for (const f of STDIO_FILES) {
    const src = readFileSync(f, "utf8");
    for (const t of extractTools(src)) stdioNames.add(t.name);
  }

  if (httpTools.length === 0) {
    throw new Error(
      `generate-mcp-tool-catalog: parsed 0 tools from ${HTTP_FILE}. ` +
        "Did the registration shape change?"
    );
  }

  // Sanity-check: every name must be unique.
  const seen = new Set();
  for (const t of httpTools) {
    if (seen.has(t.name)) {
      throw new Error(`generate-mcp-tool-catalog: duplicate tool name ${t.name}`);
    }
    seen.add(t.name);
  }

  const enriched = httpTools.map((t) => ({
    name: t.name,
    description: t.description,
    blurb: firstSentence(t.description),
    category: categorize(t.name),
    readOnly: isReadOnly(t.name),
    destructive: isDestructive(t.name),
    idempotent: isIdempotent(t.name),
    requiresWriteScope: requiresWriteScope(t.name),
    transport: stdioNames.has(t.name) ? "both" : "http",
    deprecated: isDeprecated(t.description),
  }));

  // Stable alpha sort within categories at render time; emit in registration
  // order so diff noise on add/remove is localized.
  const lines = [];
  lines.push("// AUTO-GENERATED by pf-app/scripts/generate-mcp-tool-catalog.mjs");
  lines.push("// Source-of-truth: pf-app/mcp-server/register-tools-pg.ts");
  lines.push("// Do not edit by hand — re-run `node scripts/generate-mcp-tool-catalog.mjs`.");
  lines.push("");
  lines.push("export type ToolCategory =");
  lines.push("  | \"read\"");
  lines.push("  | \"write\"");
  lines.push("  | \"preview\"");
  lines.push("  | \"execute\"");
  lines.push("  | \"destructive\"");
  lines.push("  | \"analyze\";");
  lines.push("");
  lines.push("export type ToolTransport = \"http\" | \"both\";");
  lines.push("");
  lines.push("export interface CatalogTool {");
  lines.push("  name: string;");
  lines.push("  description: string;");
  lines.push("  blurb: string;");
  lines.push("  category: ToolCategory;");
  lines.push("  readOnly: boolean;");
  lines.push("  destructive: boolean;");
  lines.push("  idempotent: boolean;");
  lines.push("  requiresWriteScope: boolean;");
  lines.push("  transport: ToolTransport;");
  lines.push("  deprecated: boolean;");
  lines.push("}");
  lines.push("");
  lines.push(`export const TOOL_COUNT_HTTP = ${enriched.length} as const;`);
  const stdioCount = enriched.filter((t) => t.transport === "both").length;
  // stdio total includes stdio-only tools that aren't in HTTP; count those separately
  const stdioOnlyCount = [...stdioNames].filter(
    (n) => !enriched.some((t) => t.name === n)
  ).length;
  lines.push(`export const TOOL_COUNT_STDIO = ${stdioCount + stdioOnlyCount} as const;`);
  lines.push("");
  lines.push("export const TOOLS: ReadonlyArray<CatalogTool> = [");
  for (const t of enriched) {
    lines.push("  {");
    lines.push(`    name: ${JSON.stringify(t.name)},`);
    lines.push(`    description: ${JSON.stringify(t.description)},`);
    lines.push(`    blurb: ${JSON.stringify(t.blurb)},`);
    lines.push(`    category: ${JSON.stringify(t.category)},`);
    lines.push(`    readOnly: ${t.readOnly},`);
    lines.push(`    destructive: ${t.destructive},`);
    lines.push(`    idempotent: ${t.idempotent},`);
    lines.push(`    requiresWriteScope: ${t.requiresWriteScope},`);
    lines.push(`    transport: ${JSON.stringify(t.transport)},`);
    lines.push(`    deprecated: ${t.deprecated},`);
    lines.push("  },");
  }
  lines.push("];");
  lines.push("");

  mkdirSync(dirname(OUTPUT_FILE), { recursive: true });
  writeFileSync(OUTPUT_FILE, lines.join("\n"), "utf8");

  // Print a summary so CI logs show drift at a glance.
  const byCat = {};
  for (const t of enriched) byCat[t.category] = (byCat[t.category] ?? 0) + 1;
  // eslint-disable-next-line no-console
  console.log(
    `generate-mcp-tool-catalog: wrote ${enriched.length} HTTP tools to ${OUTPUT_FILE}`
  );
  // eslint-disable-next-line no-console
  console.log(`  By category: ${JSON.stringify(byCat)}`);
  // eslint-disable-next-line no-console
  console.log(
    `  Transport: http-only=${enriched.filter((t) => t.transport === "http").length}, both=${stdioCount}`
  );
}

main();
