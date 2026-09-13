/**
 * Static gate: exactly ONE Next.js instrumentation hook, at the project root.
 *
 * WHY THIS EXISTS
 * ---------------
 * The repo carried two hooks: `instrumentation.ts` (root) and
 * `src/instrumentation.ts`. Only the ROOT one was ever loaded — every dev boot
 * logged its lines, and the system-metrics sampler it starts wrote a row a
 * minute — so the nightly portfolio-snapshots cron registered only in the src
 * copy never ran.
 *
 * PR #346 read that backwards: it merged everything into `src/` and deleted the
 * root file. Next then loaded the src copy, which was ALSO compiled for the
 * edge runtime and had no `NEXT_RUNTIME` guard, so a Node-only import crashed
 * the hook ("Native module not found: node:util/types") and every request
 * returned 500 on dev. `next build` and typecheck both passed — the failure
 * only appeared at runtime.
 *
 * PURE source reads — they pin the layout and wiring, not runtime behaviour.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const readHook = () => readFileSync(path.join(ROOT, "instrumentation.ts"), "utf8");

describe("instrumentation hook", () => {
  it("lives at the project root and nowhere else", () => {
    expect(existsSync(path.join(ROOT, "instrumentation.ts"))).toBe(true);
    for (const stray of ["src/instrumentation.ts", "src/instrumentation.js", "instrumentation.js"]) {
      expect(existsSync(path.join(ROOT, stray)), stray).toBe(false);
    }
  });

  it("returns before any import outside the Node.js runtime", () => {
    const src = readHook();
    const guard = src.search(/if\s*\(\s*process\.env\.NEXT_RUNTIME\s*!==\s*["']nodejs["']\s*\)\s*return/);
    expect(guard, "NEXT_RUNTIME guard").toBeGreaterThan(-1);
    expect(src.indexOf("await import("), "first dynamic import").toBeGreaterThan(guard);
  });

  it("starts every background job", () => {
    const src = readHook();
    for (const fn of [
      "startSystemMetricsSampler",
      "startEmailCleanupTimer",
      "startSettleFutureFxTimer",
      "startMcpIdempotencySweepTimer",
      "startRevokedJtisSweepTimer",
      "startExpireDcrClientsTimer",
      "runSnapshotsCron",
    ]) {
      expect(src, fn).toContain(fn);
    }
  });

  it("wires every start*() exported from src/lib/cron", () => {
    const src = readHook();
    const dir = path.join(ROOT, "src", "lib", "cron");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const text = readFileSync(path.join(dir, file), "utf8");
      for (const m of text.matchAll(/export function (start\w+)\(/g)) {
        expect(src, `${file}: ${m[1]}`).toContain(m[1]);
      }
    }
  });
});
