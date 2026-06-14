/**
 * FINLYNQ-166 — pure dormancy helpers for the admin "Last active" column.
 *
 * Covers isDormant / compareLastActive / lastActiveAtMs: the null-safe dormancy
 * predicate (NULL OR > DORMANT_DAYS ago = dormant) and the null-safe sort
 * comparator (NULL sorts as least-recently-active). No DB / no React.
 */

import { describe, it, expect } from "vitest";
import {
  DORMANT_DAYS,
  isDormant,
  compareLastActive,
  lastActiveAtMs,
} from "@/lib/auth/dormancy";

const NOW = Date.UTC(2026, 5, 14, 12, 0, 0); // fixed "now" for determinism
const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe("isDormant", () => {
  it("treats null/undefined (never active) as dormant", () => {
    expect(isDormant(null, NOW)).toBe(true);
    expect(isDormant(undefined, NOW)).toBe(true);
  });

  it("flags activity older than DORMANT_DAYS as dormant", () => {
    expect(isDormant(iso((DORMANT_DAYS + 1) * DAY), NOW)).toBe(true);
  });

  it("does NOT flag recent activity", () => {
    expect(isDormant(iso(1 * DAY), NOW)).toBe(false);
    expect(isDormant(iso((DORMANT_DAYS - 1) * DAY), NOW)).toBe(false);
  });

  it("is exclusive at the exact threshold (== DORMANT_DAYS is not yet dormant)", () => {
    expect(isDormant(iso(DORMANT_DAYS * DAY), NOW)).toBe(false);
  });

  it("accepts a custom day threshold", () => {
    expect(isDormant(iso(10 * DAY), NOW, 7)).toBe(true);
    expect(isDormant(iso(5 * DAY), NOW, 7)).toBe(false);
  });

  it("accepts a Date as well as an ISO string", () => {
    expect(isDormant(new Date(NOW - 1 * DAY), NOW)).toBe(false);
    expect(isDormant(new Date(NOW - (DORMANT_DAYS + 1) * DAY), NOW)).toBe(true);
  });

  it("treats an unparseable value as dormant (never throws)", () => {
    expect(isDormant("not-a-date", NOW)).toBe(true);
  });
});

describe("lastActiveAtMs", () => {
  it("returns null for null / undefined / unparseable", () => {
    expect(lastActiveAtMs(null)).toBeNull();
    expect(lastActiveAtMs(undefined)).toBeNull();
    expect(lastActiveAtMs("garbage")).toBeNull();
  });

  it("parses ISO strings and Dates to the same epoch ms", () => {
    expect(lastActiveAtMs(iso(0))).toBe(NOW);
    expect(lastActiveAtMs(new Date(NOW))).toBe(NOW);
  });
});

describe("compareLastActive (null-safe ascending)", () => {
  it("orders older before newer", () => {
    expect(compareLastActive(iso(10 * DAY), iso(1 * DAY))).toBeLessThan(0);
    expect(compareLastActive(iso(1 * DAY), iso(10 * DAY))).toBeGreaterThan(0);
  });

  it("sorts null as least-recently-active (epoch 0)", () => {
    // null vs a real timestamp → null is smaller (sorts first ascending).
    expect(compareLastActive(null, iso(10 * DAY))).toBeLessThan(0);
    expect(compareLastActive(iso(10 * DAY), null)).toBeGreaterThan(0);
  });

  it("treats two nulls as equal", () => {
    expect(compareLastActive(null, null)).toBe(0);
    expect(compareLastActive(null, undefined)).toBe(0);
  });

  it("produces a stable ascending order across a mixed list", () => {
    const rows = [
      { id: "recent", lastActiveAt: iso(1 * DAY) },
      { id: "never", lastActiveAt: null as string | null },
      { id: "old", lastActiveAt: iso(100 * DAY) },
    ];
    const sorted = [...rows].sort((a, b) =>
      compareLastActive(a.lastActiveAt, b.lastActiveAt),
    );
    expect(sorted.map((r) => r.id)).toEqual(["never", "old", "recent"]);
  });
});
