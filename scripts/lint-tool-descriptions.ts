/**
 * Lint the MCP HTTP tool registry against the description style guide
 * (FINLYNQ-266 / epic FINLYNQ-262 child D).
 *
 * The "Bookkeeping only" trust disclaimer used to OPEN 15+ write-tool
 * descriptions. Under client-side listing truncation (~110 chars) many of
 * those tools rendered as the SAME string, so an agent could not tell them
 * apart without a second lookup round-trip. The disclaimer now lives ONCE in
 * the server `instructions` field; each tool description opens with a
 * distinct, verb-first first sentence.
 *
 * This lint enumerates the ACTUAL registered tool surface (register the whole
 * HTTP tool set against a mock `McpServer` + stub DB — mirrors the
 * mcp-http-smoke / FINLYNQ-260 registration pattern, so it can never drift
 * from a hand-maintained list) and FAILS (exit 1) on any of:
 *
 *   (a) two tools sharing their first FIRST_60 characters of description,
 *   (b) a first sentence longer than FIRST_SENTENCE_MAX chars,
 *   (c) a description longer than DESCRIPTION_MAX chars.
 *
 * Wired into CI via `npm run lint:tool-descriptions` in `.github/workflows`.
 *
 * Rollups-first response convention (FINLYNQ-269, epic child G)
 * ------------------------------------------------------------
 * A READ tool that can return a large array (many category×period cells,
 * unbounded time series, per-row detail) MUST lead its response with bounded
 * aggregate rollups — a `totalsBy*` / `summary` block sized for a context
 * window — and gate the row-level detail behind a `detail: true` flag (or a
 * dedicated `*_detail` call). The default payload is the rollups; the verbose
 * rows are opt-in. `get_spending_trends` is the reference implementation:
 * default = `totalsByPeriod` + `totalsByCategory`; `detail:true` adds `rows`.
 * (A future lint tier can assert new large-array read tools carry a summary
 * block key.) Every multi-mode tool's modes must be documented in
 * `finlynq_help(topic="modes")` with one example each.
 */

import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPgTools } from "../mcp-server/register-tools-pg";
import type { DbLike } from "../mcp-server/tools/_shared";

// Stable env so the auth/encryption modules don't blow up at import time.
process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "lint-jwt-secret-for-tooldesc-32ch!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "lint-pepper-32chars-for-tooldesc-only";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "lint-staging-key-32chars-tooldesc-ok";

// ---- Style-guide thresholds ------------------------------------------------
const FIRST_60 = 60; // no two tools may share this many opening chars
const FIRST_SENTENCE_MAX = 120; // first sentence (verb-first opener) ceiling
const DESCRIPTION_MAX = 900; // whole-description ceiling

type RegisteredTool = { description?: string };

/** Register the full HTTP tool surface and return name → description. */
function collectRegistry(): Map<string, string> {
  // Stub DB — the lint never invokes a handler, it only reads registered
  // metadata, so a no-op execute is enough.
  const db: DbLike = {
    execute: async () => ({ rows: [], rowCount: 0 }),
  };
  const server = new McpServer({ name: "tooldesc-lint", version: "0.0.0" });
  const dek = randomBytes(32);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerPgTools(server, db as any, "default", dek);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registered = (server as any)._registeredTools as Record<string, RegisteredTool>;
  const out = new Map<string, string>();
  for (const [name, meta] of Object.entries(registered)) {
    out.set(name, (meta.description ?? "").trim());
  }
  return out;
}

/** First sentence = text up to and including the first sentence terminator. */
function firstSentence(desc: string): string {
  const m = desc.match(/^[\s\S]*?[.!?](?=\s|$)/);
  return (m ? m[0] : desc).trim();
}

type Violation = { code: string; detail: string };

function lint(registry: Map<string, string>): Violation[] {
  const violations: Violation[] = [];

  // (a) shared first-60-char openings
  const byOpening = new Map<string, string[]>();
  for (const [name, desc] of registry) {
    const opening = desc.slice(0, FIRST_60);
    const bucket = byOpening.get(opening) ?? [];
    bucket.push(name);
    byOpening.set(opening, bucket);
  }
  for (const [opening, names] of byOpening) {
    if (names.length > 1) {
      violations.push({
        code: "dup_opening",
        detail: `${names.sort().join(", ")} share their first ${FIRST_60} chars: "${opening}"`,
      });
    }
  }

  // (b) first sentence too long + (c) whole description too long
  for (const [name, desc] of registry) {
    if (!desc) {
      violations.push({ code: "empty_description", detail: `${name} has an empty description` });
      continue;
    }
    const fs = firstSentence(desc);
    if (fs.length > FIRST_SENTENCE_MAX) {
      violations.push({
        code: "first_sentence_too_long",
        detail: `${name}: first sentence is ${fs.length} chars (max ${FIRST_SENTENCE_MAX}): "${fs.slice(0, 140)}…"`,
      });
    }
    if (desc.length > DESCRIPTION_MAX) {
      violations.push({
        code: "description_too_long",
        detail: `${name}: description is ${desc.length} chars (max ${DESCRIPTION_MAX})`,
      });
    }
  }

  return violations;
}

function main(): void {
  const registry = collectRegistry();
  const violations = lint(registry);

  if (violations.length === 0) {
    console.log(
      `lint-tool-descriptions: OK — ${registry.size} HTTP tools, no first-${FIRST_60}-char collisions, ` +
        `all first sentences ≤${FIRST_SENTENCE_MAX} chars, all descriptions ≤${DESCRIPTION_MAX} chars.`
    );
    process.exit(0);
  }

  console.error(`lint-tool-descriptions: ${violations.length} violation(s) across ${registry.size} tools:\n`);
  for (const v of violations) {
    console.error(`  [${v.code}] ${v.detail}`);
  }
  console.error(
    `\nStyle guide: description opens with an imperative verb + object; no two tools may share their ` +
      `first ${FIRST_60} chars; first sentence ≤${FIRST_SENTENCE_MAX} chars; description ≤${DESCRIPTION_MAX} chars. ` +
      `The "Bookkeeping only" trust disclaimer belongs in the server \`instructions\` field, not per-tool.`
  );
  process.exit(1);
}

main();
