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
import { spanDays } from "@/lib/auth/activity-span";

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

describe("span as a filterable number", () => {
  it("is directly comparable, which is what the numeric column filter needs", () => {
    // The span is filtered as a plain number ("> 30 days") through the shared
    // per-column filter, so the only contract the UI needs is that spanDays
    // yields a finite, non-negative integer for every input shape.
    for (const last of [null, undefined, plusDays(0), plusDays(3.5), plusDays(-9), "junk"]) {
      const d = spanDays(CREATED, last as string | null);
      expect(Number.isInteger(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(0);
    }
  });
});
