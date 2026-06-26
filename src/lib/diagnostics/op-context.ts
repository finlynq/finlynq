/**
 * Operation context — the "what is calling this query" attribution layer.
 *
 * `withOp(label, fn)` runs `fn` inside an AsyncLocalStorage context tagged with
 * an operation label (an API route like `GET /api/net-worth-history`, a job like
 * `rebuild:investment`, a `cron:...`). Because async_hooks propagates the store
 * across awaits, the DB pool wrapper ([diagnostics/log.ts]) can read
 * `currentOp()` and attribute each slow query / error to the operation that
 * triggered it. When `fn` completes, the operation's wall-clock duration (+ slow
 * query / error counts) is reported to the per-op rollup ([op-rollup.ts]) that
 * powers the "Top operations (24h)" panel.
 *
 * Queries that run with no surrounding `withOp` (un-instrumented routes, the
 * sampler/flush itself) simply read `currentOp() === undefined` and are left
 * unattributed — coverage grows as more entry points adopt `withOp`.
 *
 * No static `@/db` import (reachable from the DB-adapter import chain).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { recordOpSample } from "./op-rollup";

export interface OpContext {
  op: string;
  startedAt: number;
  /** Incremented by the pool wrapper for each slow query seen during this op. */
  slowQueries: number;
}

const als = new AsyncLocalStorage<OpContext>();

export function currentOp(): OpContext | undefined {
  return als.getStore();
}

/** Run `fn` tagged with `op`; records the op's duration to the rollup on finish. */
export async function withOp<T>(op: string, fn: () => Promise<T>): Promise<T> {
  const ctx: OpContext = { op, startedAt: Date.now(), slowQueries: 0 };
  return als.run(ctx, async () => {
    let failed = false;
    try {
      return await fn();
    } catch (err) {
      failed = true;
      throw err;
    } finally {
      try {
        recordOpSample(op, Date.now() - ctx.startedAt, ctx.slowQueries, failed);
      } catch {
        // attribution must never break the operation
      }
    }
  });
}
