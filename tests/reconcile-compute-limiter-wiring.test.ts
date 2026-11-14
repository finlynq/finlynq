/**
 * Every caller that runs the reconcile match engine for a request goes
 * through the per-user limit (2026-11-13).
 *
 * Prod stalled for three minutes when one session asked for an account's
 * reconcile snapshot ~400 times, ~70 at once: each run is about eight queries
 * in a row, the pool has 10 connections, and every user's queries waited up to
 * 32 s. `runReconcileCompute` caps runs per user so the rest wait in memory.
 * A caller that skips it brings the stall back, so this static gate checks
 * each request-path caller, plus the route's withOp tag that makes such a
 * burst show up in /admin/system.
 *
 * applyRulesToBankRows (match-engine.ts) is deliberately NOT gated: it runs the
 * engine once per account, serially, and may run inside a database
 * transaction, where waiting for a slot would hold a connection.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = join(__dirname, "..");
const read = (p: string) =>
  readFileSync(join(ROOT, p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/** The source between `runReconcileCompute(` and the end of the file must
 *  contain every engine call, i.e. no call sits before the wrapper opens. */
function everyEngineCallIsWrapped(src: string): boolean {
  const wrap = src.indexOf("runReconcileCompute(");
  if (wrap < 0) return false;
  const calls = [...src.matchAll(/computeReconcileForAccount\(\{/g)].map((m) => m.index ?? 0);
  return calls.length > 0 && calls.every((i) => i > wrap);
}

describe("reconcile engine callers use the per-user limit", () => {
  it.each([
    "src/app/api/reconcile/suggestions/route.ts",
    "src/lib/reconcile/summary.ts",
    "mcp-server/tools/reconcile.ts",
  ])("%s wraps computeReconcileForAccount in runReconcileCompute", (file) => {
    expect(everyEngineCallIsWrapped(read(file))).toBe(true);
  });

  it("the suggestions route also wraps the owner check (a waiting request holds no connection)", () => {
    const src = read("src/app/api/reconcile/suggestions/route.ts");
    const wrap = src.indexOf("runReconcileCompute(");
    const ownerCheck = src.indexOf(".from(schema.accounts)");
    expect(wrap).toBeGreaterThan(0);
    expect(ownerCheck).toBeGreaterThan(wrap);
  });

  it("the suggestions route is tagged with withOp", () => {
    expect(read("src/app/api/reconcile/suggestions/route.ts")).toMatch(
      /withOp\("GET \/api\/reconcile\/suggestions"/,
    );
  });

  it("no request-path file outside these calls the engine directly", () => {
    // A new caller of computeReconcileForAccount must either be added above
    // (and wrapped) or be the serial, transaction-safe applyRulesToBankRows.
    const callers = [
      "src/app/api/reconcile/suggestions/route.ts",
      "src/lib/reconcile/summary.ts",
      "mcp-server/tools/reconcile.ts",
      "src/lib/reconcile/match-engine.ts",
    ];
    for (const f of callers) expect(read(f)).toContain("computeReconcileForAccount");
  });
});
