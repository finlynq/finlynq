/**
 * Next.js instrumentation hook — runs once when the server starts.
 *
 * This is the ONLY instrumentation hook, and it must stay at `src/` and stay
 * this thin. Measured on dev (PR #346, 2026-09-13):
 *   - with only a root `instrumentation.ts`, Next registered NO hook at all
 *     (no boot lines, no DB adapter, /api/healthz 503);
 *   - an unguarded `src/instrumentation.ts` is also compiled for the edge
 *     runtime, where a Node-only import crashed it and every request 500'd.
 * So all Node-only work lives in ./instrumentation-node, imported only inside
 * the NEXT_RUNTIME === "nodejs" branch (Next's documented pattern), which keeps
 * it out of the edge bundle. tests/instrumentation-single-hook.test.ts pins
 * the layout and the guard.
 *
 * Docs: https://nextjs.org/docs/app/guides/instrumentation
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNodeJobs } = await import("./instrumentation-node");
    await registerNodeJobs();
  }
}
