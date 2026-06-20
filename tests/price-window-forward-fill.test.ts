/**
 * Pure-unit tests for `buildForwardFilledRows` — the windowed historical
 * price-cache fill that turns a snapshot rebuild's day-by-day walk from ~1 Yahoo
 * call PER (symbol, day) into ~1 call per window. The helper forward-fills a
 * sparse run of trading-day closes into one row per CALENDAR day so weekends /
 * holidays are cache hits, and it must never emit today's (TTL-managed) row.
 *
 * `@/db` is stubbed so importing price-service.ts never touches Postgres; the
 * function under test is pure (no DB, no clock — `today` is injected).
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@/db", () => ({ db: {}, schema: { priceCache: {} } }));

import { buildForwardFilledRows } from "@/lib/price-service";

describe("buildForwardFilledRows", () => {
  it("forward-fills weekends with the most recent prior close", () => {
    // 2026-06-12 is a Friday; 2026-06-15 a Monday.
    const bars = [
      { date: "2026-06-12", close: 100 },
      { date: "2026-06-15", close: 110 },
    ];
    const rows = buildForwardFilledRows("AAPL", "USD", bars, "2026-06-12", "2026-06-15", "2026-07-01");
    expect(rows).toEqual([
      { symbol: "AAPL", date: "2026-06-12", price: 100, currency: "USD" },
      { symbol: "AAPL", date: "2026-06-13", price: 100, currency: "USD" }, // Sat → Fri close
      { symbol: "AAPL", date: "2026-06-14", price: 100, currency: "USD" }, // Sun → Fri close
      { symbol: "AAPL", date: "2026-06-15", price: 110, currency: "USD" },
    ]);
  });

  it("never emits today's or future rows (clamps upper bound to yesterday)", () => {
    const bars = [{ date: "2026-06-10", close: 50 }];
    // fillTo runs past `today`; everything from today onward must be dropped.
    const rows = buildForwardFilledRows("MSFT", "USD", bars, "2026-06-10", "2026-06-20", "2026-06-15");
    const dates = rows.map((r) => r.date);
    expect(dates).toEqual(["2026-06-10", "2026-06-11", "2026-06-12", "2026-06-13", "2026-06-14"]);
    expect(dates).not.toContain("2026-06-15"); // today excluded
    expect(dates.every((d) => d < "2026-06-15")).toBe(true);
  });

  it("skips calendar days before the first known bar", () => {
    const bars = [{ date: "2026-06-12", close: 100 }];
    const rows = buildForwardFilledRows("AAPL", "USD", bars, "2026-06-09", "2026-06-12", "2026-07-01");
    // 06-09..06-11 have no close yet → skipped; only 06-12 is emitted.
    expect(rows.map((r) => r.date)).toEqual(["2026-06-12"]);
  });

  it("fills a single bar across the whole (historical) range", () => {
    const bars = [{ date: "2026-06-10", close: 42 }];
    const rows = buildForwardFilledRows("XAU", "USD", bars, "2026-06-10", "2026-06-12", "2026-07-01");
    expect(rows.map((r) => [r.date, r.price])).toEqual([
      ["2026-06-10", 42],
      ["2026-06-11", 42],
      ["2026-06-12", 42],
    ]);
  });

  it("returns [] for empty bars or an upper bound below fillFrom", () => {
    expect(buildForwardFilledRows("AAPL", "USD", [], "2026-06-10", "2026-06-12", "2026-07-01")).toEqual([]);
    // today == fillFrom → yesterday < fillFrom → nothing to write.
    expect(
      buildForwardFilledRows("AAPL", "USD", [{ date: "2026-06-10", close: 1 }], "2026-06-15", "2026-06-20", "2026-06-15"),
    ).toEqual([]);
  });
});
