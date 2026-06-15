/**
 * FINLYNQ-166 — pure dormancy helpers for the admin "Last active" column.
 *
 * Dependency-free (no `@/db`, no React) so it is safe to import into the admin
 * CLIENT component AND unit-test in isolation. The DB-side bump lives in
 * `last-active.ts`; this module is purely the read/display + sort math.
 */

/** A user with no authenticated activity in this many days renders muted ("dormant"). */
export const DORMANT_DAYS = 60;

const MS_PER_DAY = 86_400_000;

/**
 * Whether a user is dormant given their `last_active_at`.
 *
 * Dormant === NULL (never seen active) OR older than `days` ago. Null sorts as
 * dormant on purpose: a user we've never recorded activity for is the most
 * dormant case, not the least.
 *
 * @param lastActiveAt ISO string / Date / null from `users.last_active_at`.
 * @param nowMs        current epoch ms (injectable for deterministic tests).
 * @param days         dormancy threshold in days (defaults to DORMANT_DAYS).
 */
export function isDormant(
  lastActiveAt: string | Date | null | undefined,
  nowMs: number = Date.now(),
  days: number = DORMANT_DAYS,
): boolean {
  const ts = lastActiveAtMs(lastActiveAt);
  if (ts === null) return true;
  return nowMs - ts > days * MS_PER_DAY;
}

/**
 * Parse a `last_active_at` value to epoch ms, or null when absent/unparseable.
 * Tolerates both the string (JSON over the wire) and Date (Drizzle timestamp)
 * shapes the column can take.
 */
export function lastActiveAtMs(
  lastActiveAt: string | Date | null | undefined,
): number | null {
  if (lastActiveAt === null || lastActiveAt === undefined) return null;
  const t =
    lastActiveAt instanceof Date
      ? lastActiveAt.getTime()
      : new Date(lastActiveAt).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Null-safe ascending comparator for `last_active_at` — NULL sorts as the
 * least-recently-active (treated as epoch 0), so dormant/never-active users
 * cluster at one end consistently. Multiply by the direction sign at the
 * callsite for descending.
 */
export function compareLastActive(
  a: string | Date | null | undefined,
  b: string | Date | null | undefined,
): number {
  return (lastActiveAtMs(a) ?? 0) - (lastActiveAtMs(b) ?? 0);
}
