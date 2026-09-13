/**
 * Static gate: exactly ONE Next.js instrumentation hook, at `src/`, kept thin.
 *
 * WHY THIS EXISTS
 * ---------------
 * The repo carried two hooks, `instrumentation.ts` (root) and
 * `src/instrumentation.ts`. Three deploys on dev (PR #346, 2026-09-13) showed
 * how Next 16 treats that layout:
 *   - BOTH present → a hook is registered, and it ran the ROOT file's code
 *     (so jobs registered only in the src copy, e.g. the nightly
 *     portfolio-snapshots cron, never ran);
 *   - ONLY `src/`, unguarded → the hook loaded but was also compiled for the
 *     edge runtime, where a Node-only import crashed it: every request 500'd;
 *   - ONLY root → NO hook registered at all: no DB adapter, /api/healthz 503.
 * Typecheck and `next build` passed in every case — the failures only showed
 * at runtime. The fix is one hook at `src/`, whose only job is to import the
 * Node-only module inside the NEXT_RUNTIME === "nodejs" branch.
 *
 * PURE source reads — they pin the layout and wiring, not runtime behaviour.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
/** Source with comments removed, so prose about imports can't satisfy a check. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
/**
 * The function is actually CALLED — a whole-identifier `fn(`. Destructuring it
 * out of the import (`{ startX }`) is not enough, and `runSnapshotsCronX(`
 * doesn't count as `runSnapshotsCron(`.
 */
const mentions = (src: string, ident: string) => new RegExp(`\\b${ident}\\(`).test(src);

describe("instrumentation hook", () => {
  it("lives at src/ and nowhere else", () => {
    expect(existsSync(path.join(ROOT, "src", "instrumentation.ts"))).toBe(true);
    for (const stray of ["instrumentation.ts", "instrumentation.js", "src/instrumentation.js"]) {
      expect(existsSync(path.join(ROOT, stray)), stray).toBe(false);
    }
  });

  it("has no static imports and loads Node-only code only inside the nodejs branch", () => {
    const src = code("src/instrumentation.ts");
    expect(src, "static import").not.toMatch(/^\s*import\s/m);
    const guard = src.search(/if\s*\(\s*process\.env\.NEXT_RUNTIME\s*===\s*["']nodejs["']\s*\)\s*\{/);
    expect(guard, "NEXT_RUNTIME === nodejs branch").toBeGreaterThan(-1);
    const imports = [...src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)];
    expect(imports.map((m) => m[1])).toEqual(["./instrumentation-node"]);
    expect(imports[0].index!, "import inside the branch").toBeGreaterThan(guard);
  });

  it("is the only importer of instrumentation-node", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (
          /\.(ts|tsx)$/.test(entry.name) &&
          entry.name !== "instrumentation.ts" &&
          entry.name !== "instrumentation-node.ts" &&
          /instrumentation-node/.test(readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, ""))
        ) {
          offenders.push(path.relative(ROOT, full));
        }
      }
    };
    walk(path.join(ROOT, "src"));
    expect(offenders).toEqual([]);
  });

  it("starts every background job", () => {
    const src = code("src/instrumentation-node.ts");
    for (const fn of [
      "startSystemMetricsSampler",
      "startEmailCleanupTimer",
      "startSettleFutureFxTimer",
      "startMcpIdempotencySweepTimer",
      "startRevokedJtisSweepTimer",
      "startExpireDcrClientsTimer",
      "runSnapshotsCron",
    ]) {
      expect(mentions(src, fn), fn).toBe(true);
    }
  });

  it("wires every start*() exported from src/lib/cron", () => {
    const src = code("src/instrumentation-node.ts");
    const dir = path.join(ROOT, "src", "lib", "cron");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const text = read(path.join("src", "lib", "cron", file));
      for (const m of text.matchAll(/export function (start\w+)\(/g)) {
        expect(mentions(src, m[1]), `${file}: ${m[1]}`).toBe(true);
      }
    }
  });
});
