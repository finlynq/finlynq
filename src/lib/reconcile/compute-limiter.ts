/**
 * At most RECONCILE_COMPUTES_PER_USER reconcile match-engine runs at a time
 * per user (2026-11-13).
 *
 * One run of `computeReconcileForAccount` is about eight queries in a row. On
 * prod a single session asked for one account's snapshot ~400 times in three
 * minutes (13:41-13:44 UTC), about 70 at once; the pool has 10 connections, so
 * every query of every user waited up to 32 s. With this limit the extra
 * requests wait in memory and other users are served at once.
 *
 * Wrap the WHOLE per-account unit (owner check, thresholds, engine run) so a
 * waiting request holds no connection. Never call it while holding a database
 * transaction, and never nest it: a run that waits for a slot its own caller
 * holds would never start.
 *
 * Kept on globalThis so every route bundle in the process shares one limiter
 * (and HMR does not reset it in dev).
 */

import { createKeyedLimiter, type KeyedLimiter } from "../concurrency/keyed-limiter";

export const RECONCILE_COMPUTES_PER_USER = 3;

const g = globalThis as typeof globalThis & { __pfReconcileComputeLimiter?: KeyedLimiter };

function limiter(): KeyedLimiter {
  if (!g.__pfReconcileComputeLimiter) {
    g.__pfReconcileComputeLimiter = createKeyedLimiter(RECONCILE_COMPUTES_PER_USER);
  }
  return g.__pfReconcileComputeLimiter;
}

/** Run one per-account reconcile unit for `userId` under the per-user limit. */
export function runReconcileCompute<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return limiter().run(userId, fn);
}

/** Runs + waiters for one user (tests and diagnostics). */
export function pendingReconcileComputes(userId: string): number {
  return limiter().pending(userId);
}
