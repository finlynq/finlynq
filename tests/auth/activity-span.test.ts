/**
 * Pins the active-span math behind the admin users table's new column + filter.
 *
 * WHY THIS EXISTS
 * ---------------
 * The span is computed TWICE: in SQL (`ACTIVE_SPAN_SQL` in @/lib/auth/queries,
 * which the server-side sort and bucket filter run on) and in TS (`spanDays`
 * here, the shape the client renders). If the two disagree, a user can be
 * filtered into the "1–7 days" bucket while their row renders "0" — the row and
 * the filter contradicting each other, which is exactly the class of bug the
 * server-side rewrite was meant to end.
 *
 * The load-bearing rule both sides share: a NULL `last_active_at` (a user we
 * have never seen authenticate — 13 of 27 rows on dev) is ZERO, never null and
 * never hidden. These tests pin that, plus the clamps that keep a negative or
 * unparseable value from leaking into the UI.
 */

import { describe, it, expect } from "vitest";
import {
  SPAN_BUCKETS,
  spanDays,
  bucketForSpan,
  isSpanBucketId,
  spanBucketById,
} from "@/lib/auth/activity-span";

const DAY = 86_400_000;
const CREATED = "2026-04-01T00:00:00.000Z";
const createdMs = Date.parse(CREATED);
const plusDays = (n: number) => new Date(createdMs + n * DAY).toISOString();

describe("spanDays", () => {
  it("counts whole days between signup and last activity", () => {
    expect(spanDays(CREATED, plusDays(14))).toBe(14);
    expect(spanDays(CREATED, plusDays(97))).toBe(97);
  });

  it("floors a partial day rather than rounding up", () => {
    expect(spanDays(CREATED, plusDays(7.9))).toBe(7);
  });

  it("returns 0 — not null — for a never-active user", () => {
    // The whole point: these users must still render and still match a bucket.
    expect(spanDays(CREATED, null)).toBe(0);
    expect(spanDays(CREATED, undefined)).toBe(0);
  });

  it("clamps a negative span (clock skew / backdated created_at) to 0", () => {
    expect(spanDays(CREATED, plusDays(-5))).toBe(0);
  });

  it("returns 0 when either timestamp is unparseable", () => {
    expect(spanDays("not-a-date", plusDays(10))).toBe(0);
    expect(spanDays(CREATED, "not-a-date")).toBe(0);
  });

  it("accepts Date objects (the Drizzle timestamptz shape) as well as strings", () => {
    expect(spanDays(CREATED, new Date(createdMs + 30 * DAY))).toBe(30);
  });
});

describe("bucketForSpan", () => {
  it("puts a never-active / same-day user in the first bucket", () => {
    expect(bucketForSpan(0)).toBe("0");
    expect(bucketForSpan(spanDays(CREATED, null))).toBe("0");
  });

  it("maps each bucket's boundaries to that bucket", () => {
    expect(bucketForSpan(1)).toBe("1-7");
    expect(bucketForSpan(7)).toBe("1-7");
    expect(bucketForSpan(8)).toBe("8-30");
    expect(bucketForSpan(30)).toBe("8-30");
    expect(bucketForSpan(31)).toBe("31-90");
    expect(bucketForSpan(90)).toBe("31-90");
    expect(bucketForSpan(91)).toBe("90plus");
    expect(bucketForSpan(10_000)).toBe("90plus");
  });

  it("clamps negative / non-finite input into the first bucket", () => {
    expect(bucketForSpan(-1)).toBe("0");
    expect(bucketForSpan(Number.NaN)).toBe("0");
  });
});

describe("SPAN_BUCKETS", () => {
  it("is contiguous and non-overlapping, so every span matches exactly one", () => {
    // The SQL filter is a plain BETWEEN per bucket — a gap would make a user
    // unreachable by any filter value, an overlap would double-count them.
    for (let i = 1; i < SPAN_BUCKETS.length; i++) {
      const prev = SPAN_BUCKETS[i - 1];
      const cur = SPAN_BUCKETS[i];
      expect(prev.max).not.toBeNull();
      expect(cur.min).toBe((prev.max as number) + 1);
    }
    expect(SPAN_BUCKETS[0].min).toBe(0);
    // Only the last bucket may be unbounded, or large spans fall through.
    expect(SPAN_BUCKETS[SPAN_BUCKETS.length - 1].max).toBeNull();
  });

  it("covers every span from 0 upward", () => {
    for (const days of [0, 1, 5, 7, 8, 29, 30, 31, 60, 90, 91, 500]) {
      const id = bucketForSpan(days);
      const bucket = spanBucketById(id);
      expect(bucket).not.toBeNull();
      expect(days).toBeGreaterThanOrEqual(bucket!.min);
      if (bucket!.max !== null) expect(days).toBeLessThanOrEqual(bucket!.max);
    }
  });
});

describe("isSpanBucketId", () => {
  it("accepts every real bucket id", () => {
    for (const b of SPAN_BUCKETS) expect(isSpanBucketId(b.id)).toBe(true);
  });

  it("rejects anything else — the route 400s on these", () => {
    for (const bad of ["", "all", "0-7", "90+", null, undefined, 7, {}]) {
      expect(isSpanBucketId(bad)).toBe(false);
    }
  });
});
