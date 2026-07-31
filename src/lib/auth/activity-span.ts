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

export interface SpanBucket {
  /** Stable id — the wire value for the `spanBucket` query param. */
  id: string;
  label: string;
  /** Inclusive lower bound, in days. */
  min: number;
  /** Inclusive upper bound, in days. `null` = unbounded. */
  max: number | null;
}

/**
 * The filter buckets, in ascending order. Contiguous and non-overlapping by
 * construction — every span >= 0 falls in exactly one — which is what lets
 * `bucketForSpan` return a total function and the SQL filter be a plain
 * BETWEEN. Keep them contiguous if you edit this list.
 */
export const SPAN_BUCKETS = [
  { id: "0", label: "0 days (incl. never active)", min: 0, max: 0 },
  { id: "1-7", label: "1–7 days", min: 1, max: 7 },
  { id: "8-30", label: "8–30 days", min: 8, max: 30 },
  { id: "31-90", label: "31–90 days", min: 31, max: 90 },
  { id: "90plus", label: "Over 90 days", min: 91, max: null },
] as const satisfies readonly SpanBucket[];

export type SpanBucketId = (typeof SPAN_BUCKETS)[number]["id"];

/** Narrowing guard for an untrusted query-param value. */
export function isSpanBucketId(value: unknown): value is SpanBucketId {
  return (
    typeof value === "string" &&
    SPAN_BUCKETS.some((b) => b.id === value)
  );
}

/** The bucket descriptor for an id, or null when the id is unknown. */
export function spanBucketById(id: string): SpanBucket | null {
  return SPAN_BUCKETS.find((b) => b.id === id) ?? null;
}

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

/**
 * The bucket a span falls into. Total over every finite span >= 0 because the
 * buckets are contiguous and the last one is unbounded; negative or non-finite
 * input clamps into the first bucket (consistent with `spanDays`' own clamp).
 */
export function bucketForSpan(days: number): SpanBucketId {
  if (!Number.isFinite(days) || days <= 0) return SPAN_BUCKETS[0].id;
  for (const b of SPAN_BUCKETS) {
    if (days >= b.min && (b.max === null || days <= b.max)) return b.id;
  }
  // Unreachable while the last bucket is unbounded — kept so a future edit that
  // bounds it degrades to "highest bucket" rather than undefined.
  return SPAN_BUCKETS[SPAN_BUCKETS.length - 1].id;
}
