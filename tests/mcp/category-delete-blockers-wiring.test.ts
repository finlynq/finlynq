/**
 * MCP category delete checks every blocking table, like the web route
 * (2026-11-13).
 *
 * `manage_categories(op:delete)` and stdio `delete_category` counted only
 * transactions, rules and subscriptions, so a category with a budget (or a
 * budget template, recurring transaction or split) reached Postgres and came
 * back as a raw foreign-key error: five on prod in one morning, four of them
 * within 3 s from an assistant retrying. Both now use
 * getCategoryDeleteBlockers, the helper the web DELETE route uses, and keep
 * their rule count (rules reference a category inside JSONB, not by foreign
 * key). Static gate, because the helper's own tests pass whether or not a
 * delete path calls it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) =>
  readFileSync(join(ROOT, p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/** The text of the function/handler containing `marker`, up to `end`. */
function slice(src: string, marker: string, end: string): string {
  const i = src.indexOf(marker);
  expect(i, `marker not found: ${marker}`).toBeGreaterThanOrEqual(0);
  const j = src.indexOf(end, i);
  return src.slice(i, j < 0 ? undefined : j);
}

describe("MCP HTTP manage_categories(op:delete)", () => {
  const src = read("mcp-server/tools/categories.ts");

  it("the preview counts blockers through the shared helper", () => {
    const preview = slice(src, "async function opDeletePreview", "async function opDeleteCommit");
    expect(preview).toContain("getCategoryDeleteBlockers(db, userId, catId)");
    expect(preview).not.toMatch(/FROM transactions WHERE user_id/);
  });

  it("the commit re-checks through the shared helper before the DELETE", () => {
    const commit = slice(src, "async function opDeleteCommit", "async function opCreate");
    const check = commit.indexOf("getCategoryDeleteBlockers(db, userId, id)");
    const del = commit.indexOf("DELETE FROM categories");
    expect(check).toBeGreaterThan(0);
    expect(del).toBeGreaterThan(check);
    expect(commit).toContain("transaction_rules");
  });
});

describe("stdio delete_category", () => {
  const src = read("mcp-server/register-core-tools.ts");
  const handler = slice(src, '"delete_category"', "server.tool(");

  it("checks the shared blockers before the DELETE and refuses if it cannot", () => {
    const check = handler.indexOf("getCategoryDeleteBlockers(db, userId, id)");
    const del = handler.indexOf("DELETE FROM categories");
    expect(check).toBeGreaterThan(0);
    expect(del).toBeGreaterThan(check);
    expect(handler).toMatch(/catch \(e\) \{\s*return sqliteErr\(/);
  });
});
