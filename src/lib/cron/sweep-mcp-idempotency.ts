/**
 * Background sweep for MCP idempotency keys (issue #98).
 *
 * Deletes rows in `mcp_idempotency_keys` older than 72h. The TTL is enforced
 * twice: once on read (the lookup query in `bulk_record_transactions` filters
 * `created_at > NOW() - INTERVAL '72 hours'` so stale rows can't replay even
 * if they're still in the table), and again here so the table doesn't grow
 * without bound.
 *
 * Daily interval, fire-and-forget. Safe to call repeatedly — each sweep is
 * idempotent. Wired in `instrumentation.ts` once the PostgresAdapter is ready.
 */

import { db, schema } from "@/db";
import { sql, lt } from "drizzle-orm";

export type SweepResult = { deleted: number };

/**
 * Delete `mcp_idempotency_keys` rows older than 72h. Returns the number of
 * rows removed. Best-effort — a thrown error bubbles to the caller, which
 * logs and resumes on the next interval.
 */
export async function sweepMcpIdempotencyKeys(): Promise<SweepResult> {
  // Compute the cutoff in JS so the filter is portable across drivers — the
  // table's `created_at_idx` makes this a cheap range scan.
  const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000);
  const deleted = await db
    .delete(schema.mcpIdempotencyKeys)
    .where(lt(schema.mcpIdempotencyKeys.createdAt, cutoff))
    .returning({ id: schema.mcpIdempotencyKeys.id });
  // Touch `sql` so the import isn't tree-shaken in builds where the
  // returning() rowcount path is the only consumer.
  void sql;
  return { deleted: deleted.length };
}

let timer: NodeJS.Timeout | null = null;

/**
 * Start the daily sweep. Safe to call multiple times — second call is a
 * no-op.
 */
export function startMcpIdempotencySweepTimer(): void {
  if (timer) return;
  const ONE_DAY = 24 * 60 * 60 * 1000;
  timer = setInterval(() => {
    sweepMcpIdempotencyKeys().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[sweep-mcp-idempotency] sweep failed:", err);
    });
  }, ONE_DAY);
  if (timer.unref) timer.unref();
}

/** Stop the sweep interval. For tests. */
export function stopMcpIdempotencySweepTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
