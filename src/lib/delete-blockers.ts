/**
 * Shared primitives for "why can't I delete this row?" pre-flight checks.
 *
 * Several tables are referenced by ON DELETE NO ACTION foreign keys, so a
 * delete that looks fine to the user dies on a raw Postgres 23503 — which
 * surfaces as a generic 500/409 and lands in `diagnostics_log` as a db_error.
 * The fix in every case is the same shape: count the blocking rows in ONE
 * round trip, then refuse with a message naming what is actually in the way,
 * so the doomed DELETE never reaches Postgres.
 *
 * Per-entity modules live next to their domain and own the table list + the
 * refusal wording; only the plumbing lives here:
 *   - [accounts/delete-blockers.ts](./accounts/delete-blockers.ts)
 *   - [categories/delete-blockers.ts](./categories/delete-blockers.ts)
 */

import type { sql } from "drizzle-orm";

/**
 * Minimal structural type satisfied by BOTH the app's Drizzle proxy (`@/db`)
 * and the MCP tool context's `DbLike` (mcp-server/tools/_shared.ts), so one
 * helper serves both surfaces without either importing the other.
 */
export type Executor = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

export interface DeleteBlocker {
  /** Table holding the rows that block the delete. */
  table: string;
  /** Singular human-readable noun, for message building. */
  label: string;
  count: number;
}

/** `"10 transactions, 8 investment holdings and 1 goal"`. */
export function describeDeleteBlockers(blockers: DeleteBlocker[]): string {
  const parts = blockers.map((b) => `${b.count} ${b.label}${b.count === 1 ? "" : "s"}`);
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * Project a single-row `SELECT (subquery) AS <table>, …` result onto the
 * declared blocker list, keeping declaration order and dropping the empties.
 * An empty array means the delete is safe to attempt.
 */
export function collectBlockers(
  counts: Record<string, unknown>,
  declared: ReadonlyArray<{ table: string; label: string }>,
): DeleteBlocker[] {
  return declared
    .map((b) => ({ table: b.table, label: b.label, count: Number(counts[b.table] ?? 0) }))
    .filter((b) => b.count > 0);
}
