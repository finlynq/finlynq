/**
 * Active-span helpers for the admin users table.
 *
 * The "active span" is how many whole days elapsed between a user signing up
 * (`users.created_at`) and the last authenticated activity we recorded for them
 * (`users.last_active_at`) — i.e. how long they stuck around. It is a retention
 * signal, deliberately distinct from dormancy (`@/lib/auth/dormancy`), which
 * measures staleness relative to *now*.
 *
 * Dependency-free (no `@/db`, no React) so it is safe to import into the admin
 * CLIENT component AND unit-test in isolation — same contract as dormancy.ts,
 * whose timestamp parser this reuses.
 *
 * ── Load-bearing convention: a never-active user has a span of ZERO, not null.
 * `users.last_active_at` is NULL for a user we have never seen authenticate
 * (13 of 27 rows on dev at time of writing). Those users always render and are
 * always filterable — they land in the `0` bucket alongside same-day users
 * rather than being hidden or excluded. The SQL mirror of this rule lives in
 * `listUsersPage` (`@/lib/auth/queries`) as a COALESCE to 0; the two MUST agree
 * or a server-filtered page would disagree with the number rendered in the row.
 */

import { lastActiveAtMs } from "@/lib/auth/dormancy";

const MS_PER_DAY = 86_400_000;

/**
 * Whole days between signup and last recorded activity.
 *
 * Returns 0 — never null — when `lastActiveAt` is absent (never active), when
 * either timestamp is unparseable, or when the difference is negative (clock
 * skew / a backdated `created_at` must not render as a negative span).
 *
 * `lastActiveAtMs` is reused as a generic ISO-string|Date|null → epoch-ms
 * parser; despite its name it carries no last-active-specific semantics, and
 * `users.created_at` is an ISO **text** column that parses identically.
 *
 * @param createdAt    `users.created_at` (ISO text).
 * @param lastActiveAt `users.last_active_at` (timestamptz → string | Date | null).
 */
export function spanDays(
  createdAt: string | Date | null | undefined,
  lastActiveAt: string | Date | null | undefined,
): number {
  const last = lastActiveAtMs(lastActiveAt);
  if (last === null) return 0;
  const created = lastActiveAtMs(createdAt);
  if (created === null) return 0;
  const days = Math.floor((last - created) / MS_PER_DAY);
  return days > 0 ? days : 0;
}

// NOTE: this module deliberately exposes no bucket/band vocabulary. The span is
// filtered as a plain NUMBER through the shared per-column filter
// (@/lib/table-filters), so "> 30 days" is expressible directly rather than
// only via a predefined band.
