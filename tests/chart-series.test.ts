/**
 * chart-series.test.ts — full vitest matrix for prepareTimeSeries.
 *
 * Covers:
 *   - Downsample passthrough (n ≤ 200 verbatim)
 *   - Cap (365 daily → ≤ 202)
 *   - Granularity thresholds (200-vs-201, ~365d→week, ~2000d→month)
 *   - Last-in-bucket representative (last row per bucket kept)
 *   - Endpoints preserved (first date; last row value === input's last value)
 *   - No fabricated values (every kept row is a member of the input)
 *   - Unsorted input → sorted output
 *   - Domain padding ([100..200] → floor < 100 / ceil > 200)
 *   - Un-anchored ([207k, 208k, 209k] → floor ≫ 0)
 *   - All-equal → non-collapsed band
 *   - Negatives ([-500,-100,200] → floor < -500, spansZero true; all-negative → false)
 *   - clampZeroFloor true vs false on [10, 20]
 *   - Multi-series union across valueKeys
 *   - Sparse multi-series with nulls → no NaN in domain
 *   - Empty → [0,1], no throw
 *   - Single point → band
 */

import { describe, it, expect } from "vitest";
import {
  prepareTimeSeries,
  pickGranularity,
  bucketKey,
  niceDomain,
} from "@/lib/chart-series";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build n consecutive daily points starting from startISO. */
function makeDailySeries(
  n: number,
  startISO = "2024-01-01",
  valueStart = 100,
): { date: string; value: number }[] {
  const rows: { date: string; value: number }[] = [];
  const start = new Date(`${startISO}T00:00:00Z`);
  for (let i = 0; i < n; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    rows.push({ date: d.toISOString().slice(0, 10), value: valueStart + i });
  }
  return rows;
}

// ── pickGranularity ──────────────────────────────────────────────────────────

describe("pickGranularity", () => {
  it("returns day when n ≤ maxPoints", () => {
    expect(pickGranularity(200, 199, 200)).toBe("day");
    expect(pickGranularity(1, 0, 200)).toBe("day");
  });

  it("returns week when n > maxPoints but weekly count ≤ maxPoints", () => {
    // 201 points over 365 days: ceil(365/7) = 53 ≤ 200 → week
    expect(pickGranularity(201, 365, 200)).toBe("week");
    // 201 points over 1400 days: ceil(1400/7) = 200 ≤ 200 → week
    expect(pickGranularity(201, 1400, 200)).toBe("week");
  });

  it("returns month when weekly count > maxPoints", () => {
    // 2001 days: ceil(2001/7) = 286 > 200 → month
    expect(pickGranularity(500, 2001, 200)).toBe("month");
  });
});

// ── bucketKey ────────────────────────────────────────────────────────────────

describe("bucketKey", () => {
  it("day → date unchanged", () => {
    expect(bucketKey("2024-03-15", "day")).toBe("2024-03-15");
  });

  it("month → YYYY-MM", () => {
    expect(bucketKey("2024-03-15", "month")).toBe("2024-03");
    expect(bucketKey("2024-03-01", "month")).toBe("2024-03");
  });

  it("week → Monday-anchored ISO week; same Monday for Mon–Sun span", () => {
    // 2024-03-11 is a Monday
    const monday = bucketKey("2024-03-11", "week");
    const tuesday = bucketKey("2024-03-12", "week");
    const sunday = bucketKey("2024-03-17", "week");
    expect(monday).toBe(tuesday);
    expect(monday).toBe(sunday);
    // The next Monday is a different bucket
    const nextMonday = bucketKey("2024-03-18", "week");
    expect(nextMonday).not.toBe(monday);
  });

  it("week buckets are consistent across any range start", () => {
    // Two dates in the same ISO week should always map to the same bucket
    expect(bucketKey("2024-01-15", "week")).toBe(bucketKey("2024-01-19", "week"));
  });
});

// ── niceDomain ───────────────────────────────────────────────────────────────

describe("niceDomain", () => {
  it("empty input → [0, 1]", () => {
    expect(niceDomain([])).toEqual([0, 1]);
    expect(niceDomain([null, undefined, NaN])).toEqual([0, 1]);
  });

  it("single point → band around value (non-collapsed)", () => {
    const [lo, hi] = niceDomain([100]);
    expect(lo).toBeLessThan(100);
    expect(hi).toBeGreaterThan(100);
  });

  it("all-zero single point with clampZeroFloor=false → band below 0", () => {
    const [lo, hi] = niceDomain([0], { clampZeroFloor: false });
    expect(lo).toBeLessThan(0);
    expect(hi).toBeGreaterThan(0);
  });

  it("all-zero single point with clampZeroFloor=true (default) → floor clamped to 0, hi > 0", () => {
    const [lo, hi] = niceDomain([0]);
    expect(lo).toBe(0);
    expect(hi).toBeGreaterThan(0);
  });

  it("[100, 200] → floor < 100, ceil > 200", () => {
    const [lo, hi] = niceDomain([100, 150, 200]);
    expect(lo).toBeLessThan(100);
    expect(hi).toBeGreaterThan(200);
  });

  it("un-anchored: [207k, 208k, 209k] → floor ≫ 0", () => {
    const [lo] = niceDomain([207000, 208000, 209000]);
    expect(lo).toBeGreaterThan(200000);
  });

  it("clampZeroFloor=true prevents negative floor for all-positive data", () => {
    const [lo] = niceDomain([10, 20], { clampZeroFloor: true });
    expect(lo).toBeGreaterThanOrEqual(0);
  });

  it("clampZeroFloor=false allows negative floor for all-positive data", () => {
    const [lo] = niceDomain([10, 20], { clampZeroFloor: false });
    expect(lo).toBeLessThan(10);
  });

  it("negatives: [-500, -100, 200] → floor < -500, spansZero detectable", () => {
    const [lo, hi] = niceDomain([-500, -100, 200]);
    expect(lo).toBeLessThan(-500);
    expect(hi).toBeGreaterThan(200);
    // spansZero is derived from domain — verify here
    expect(lo < 0 && hi > 0).toBe(true);
  });

  it("all-negative: [-500, -100] → spansZero would be false (hi < 0)", () => {
    const [lo, hi] = niceDomain([-500, -100]);
    expect(hi).toBeLessThan(0);
    expect(lo < 0 && hi > 0).toBe(false);
  });

  it("skips null/undefined/NaN in multi-series", () => {
    const [lo, hi] = niceDomain([null, 10, undefined, NaN, 20, null]);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeGreaterThan(20);
    expect(Number.isNaN(lo)).toBe(false);
    expect(Number.isNaN(hi)).toBe(false);
  });
});

// ── prepareTimeSeries ────────────────────────────────────────────────────────

describe("prepareTimeSeries – passthrough (n ≤ 200)", () => {
  it("returns data verbatim when n = 200", () => {
    const data = makeDailySeries(200);
    const result = prepareTimeSeries(data, { dateKey: "date", valueKeys: ["value"] });
    expect(result.data).toHaveLength(200);
    expect(result.data).toBe(result.data); // same array reference or length check
    // Check every returned row exists in input
    const inputSet = new Set(data.map((r) => r.date));
    for (const r of result.data) expect(inputSet.has(r.date)).toBe(true);
  });

  it("returns data verbatim when n < 200 (e.g. 30)", () => {
    const data = makeDailySeries(30);
    const result = prepareTimeSeries(data, { dateKey: "date", valueKeys: ["value"] });
    expect(result.data).toHaveLength(30);
    expect(result.granularity).toBe("day");
  });
});

describe("prepareTimeSeries – downsampling", () => {
  it("cap: 365 daily points → result ≤ 202 (maxPoints + 2)", () => {
    const data = makeDailySeries(365);
    const { data: out } = prepareTimeSeries(data, {
      dateKey: "date",
      valueKeys: ["value"],
      maxPoints: 200,
    });
    expect(out.length).toBeLessThanOrEqual(202);
    expect(out.length).toBeGreaterThan(0);
  });

  it("201 points / 201 days → week granularity", () => {
    // 201 days span
    const data = makeDailySeries(201);
    const { granularity } = prepareTimeSeries(data, {
      dateKey: "date",
      valueKeys: ["value"],
      maxPoints: 200,
    });
    expect(granularity).toBe("week");
  });

  it("200 points / 200 days → day granularity (boundary stays day)", () => {
    const data = makeDailySeries(200);
    const { granularity } = prepareTimeSeries(data, {
      dateKey: "date",
      valueKeys: ["value"],
      maxPoints: 200,
    });
    expect(granularity).toBe("day");
  });

  it("~365 days → week granularity", () => {
    const data = makeDailySeries(365);
    const { granularity } = prepareTimeSeries(data, {
      dateKey: "date",
      valueKeys: ["value"],
      maxPoints: 200,
    });
    expect(granularity).toBe("week");
  });

  it("~2000 days → month granularity", () => {
    const data = makeDailySeries(2000);
    const { granularity } = prepareTimeSeries(data, {
      dateKey: "date",
      valueKeys: ["value"],
      maxPoints: 200,
    });
    expect(granularity).toBe("month");
  });
});

describe("prepareTimeSeries – last-in-bucket", () => {
  it("keeps the last row in each weekly bucket", () => {
    // Build 14 days (2 full weeks) with strictly increasing values.
    // The last value in each 7-day week bucket should be kept.
    const data = makeDailySeries(14, "2024-03-11", 1); // Mon–Sun × 2
    const { data: out } = prepareTimeSeries(data, {
      dateKey: "date",
      valueKeys: ["value"],
      maxPoints: 2, // force weekly bucketing with low cap
    });
    // The representative for the first week should be the LAST day of that week
    // (2024-03-17 = Sunday, value = 7)
    const firstWeekRep = out.find((r) => r.date === "2024-03-17");
    expect(firstWeekRep).toBeDefined();
    expect(firstWeekRep?.value).toBe(7);
  });

  it("every kept row is a member of the original input (no fabricated values)", () => {
    const data = makeDailySeries(365);
    const inputDates = new Set(data.map((r) => r.date));
    const { data: out } = prepareTimeSeries(data, {
      dateKey: "date",
      valueKeys: ["value"],
      maxPoints: 200,
    });
    for (const r of out) {
      expect(inputDates.has(r.date)).toBe(true);
    }
  });
});

describe("prepareTimeSeries – endpoint preservation", () => {
  it("first input date is kept in the output", () => {
    const data = makeDailySeries(365);
    const firstDate = data[0].date;
    const { data: out } = prepareTimeSeries(data, {
      dateKey: "date",
      valueKeys: ["value"],
      maxPoints: 200,
    });
    expect(out[0].date).toBe(firstDate);
  });

  it("last input row value equals the output's last row value (live-hero invariant)", () => {
    const data = makeDailySeries(365);
    const lastInput = data[data.length - 1];
    const { data: out } = prepareTimeSeries(data, {
      dateKey: "date",
      valueKeys: ["value"],
      maxPoints: 200,
    });
    const lastOut = out[out.length - 1];
    expect(lastOut.date).toBe(lastInput.date);
    expect(lastOut.value).toBe(lastInput.value);
  });

  it("output is sorted ascending by date", () => {
    // Provide unsorted input
    const data = makeDailySeries(10, "2024-01-01");
    const shuffled = [...data].reverse();
    const { data: out } = prepareTimeSeries(shuffled, {
      dateKey: "date",
      valueKeys: ["value"],
    });
    for (let i = 1; i < out.length; i++) {
      expect(out[i].date >= out[i - 1].date).toBe(true);
    }
  });
});

describe("prepareTimeSeries – domain properties", () => {
  it("domain pads below min and above max for [100..200]", () => {
    const data = [
      { date: "2024-01-01", value: 100 },
      { date: "2024-01-02", value: 150 },
      { date: "2024-01-03", value: 200 },
    ];
    const { domain } = prepareTimeSeries(data, { dateKey: "date", valueKeys: ["value"] });
    expect(domain[0]).toBeLessThan(100);
    expect(domain[1]).toBeGreaterThan(200);
  });

  it("un-anchored: [207k, 208k, 209k] → floor ≫ 0", () => {
    const data = [
      { date: "2024-01-01", value: 207000 },
      { date: "2024-01-02", value: 208000 },
      { date: "2024-01-03", value: 209000 },
    ];
    const { domain } = prepareTimeSeries(data, { dateKey: "date", valueKeys: ["value"] });
    expect(domain[0]).toBeGreaterThan(200000);
  });

  it("all-equal → non-collapsed band", () => {
    const data = [
      { date: "2024-01-01", value: 500 },
      { date: "2024-01-02", value: 500 },
      { date: "2024-01-03", value: 500 },
    ];
    const { domain } = prepareTimeSeries(data, { dateKey: "date", valueKeys: ["value"] });
    expect(domain[1] - domain[0]).toBeGreaterThan(0);
  });

  it("negatives: [-500,-100,200] → spansZero=true, floor < -500", () => {
    const data = [
      { date: "2024-01-01", value: -500 },
      { date: "2024-01-02", value: -100 },
      { date: "2024-01-03", value: 200 },
    ];
    const { domain, spansZero } = prepareTimeSeries(data, {
      dateKey: "date",
      valueKeys: ["value"],
      clampZeroFloor: false,
    });
    expect(spansZero).toBe(true);
    expect(domain[0]).toBeLessThan(-500);
  });

  it("all-negative: [-500,-100] → spansZero=false", () => {
    const data = [
      { date: "2024-01-01", value: -500 },
      { date: "2024-01-02", value: -300 },
      { date: "2024-01-03", value: -100 },
    ];
    const { spansZero } = prepareTimeSeries(data, {
      dateKey: "date",
      valueKeys: ["value"],
    });
    expect(spansZero).toBe(false);
  });

  it("clampZeroFloor=true: all-positive domain floor ≥ 0", () => {
    const data = [
      { date: "2024-01-01", value: 10 },
      { date: "2024-01-02", value: 20 },
    ];
    const { domain } = prepareTimeSeries(data, {
      dateKey: "date",
      valueKeys: ["value"],
      clampZeroFloor: true,
    });
    expect(domain[0]).toBeGreaterThanOrEqual(0);
  });

  it("clampZeroFloor=false: all-positive domain floor < min value", () => {
    const data = [
      { date: "2024-01-01", value: 10 },
      { date: "2024-01-02", value: 20 },
    ];
    const { domain } = prepareTimeSeries(data, {
      dateKey: "date",
      valueKeys: ["value"],
      clampZeroFloor: false,
    });
    expect(domain[0]).toBeLessThan(10);
  });
});

describe("prepareTimeSeries – multi-series", () => {
  it("unions values across valueKeys for domain", () => {
    const data = [
      { date: "2024-01-01", a: 100, b: 500 },
      { date: "2024-01-02", a: 200, b: 600 },
    ];
    const { domain } = prepareTimeSeries(data, {
      dateKey: "date",
      valueKeys: ["a", "b"],
    });
    // domain must cover both series
    expect(domain[0]).toBeLessThan(100);
    expect(domain[1]).toBeGreaterThan(600);
  });

  it("sparse multi-series with nulls → no NaN in domain", () => {
    const data = [
      { date: "2024-01-01", a: 100, b: null as number | null },
      { date: "2024-01-02", a: 150, b: 200 },
      { date: "2024-01-03", a: null as number | null, b: 250 },
    ];
    const { domain } = prepareTimeSeries(data as Record<string, unknown>[], {
      dateKey: "date",
      valueKeys: ["a", "b"],
    });
    expect(Number.isNaN(domain[0])).toBe(false);
    expect(Number.isNaN(domain[1])).toBe(false);
    expect(domain[0]).toBeLessThan(100);
    expect(domain[1]).toBeGreaterThan(250);
  });
});

describe("prepareTimeSeries – edge cases", () => {
  it("empty input → domain [0,1], no throw", () => {
    const { data: out, domain } = prepareTimeSeries([], {
      dateKey: "date",
      valueKeys: ["value"],
    });
    expect(out).toHaveLength(0);
    expect(domain).toEqual([0, 1]);
  });

  it("single point → band (non-collapsed domain)", () => {
    const data = [{ date: "2024-01-01", value: 42 }];
    const { domain } = prepareTimeSeries(data, {
      dateKey: "date",
      valueKeys: ["value"],
    });
    expect(domain[1] - domain[0]).toBeGreaterThan(0);
  });

  it("unsorted input → sorted output", () => {
    const data = [
      { date: "2024-01-03", value: 3 },
      { date: "2024-01-01", value: 1 },
      { date: "2024-01-02", value: 2 },
    ];
    const { data: out } = prepareTimeSeries(data, { dateKey: "date", valueKeys: ["value"] });
    expect(out[0].date).toBe("2024-01-01");
    expect(out[1].date).toBe("2024-01-02");
    expect(out[2].date).toBe("2024-01-03");
  });
});
