import { describe, it, expect } from "vitest";
import {
  analyzeRecurringGroup,
  isStale,
  STALENESS_THRESHOLD_MULTIPLIER,
} from "@/lib/recurring-detection";

describe("analyzeRecurringGroup (Issue #235)", () => {
  it("drops groups with fewer than 3 occurrences as too_few_occurrences", () => {
    const c = analyzeRecurringGroup(
      [
        { date: "2026-04-01", amount: -50 },
        { date: "2026-05-01", amount: -50 },
      ],
      "2026-05-10",
    );
    expect(c.detected).toBe(false);
    expect(c.dropReason).toBe("too_few_occurrences");
  });

  it("drops groups with near-zero average as amount_too_small", () => {
    const c = analyzeRecurringGroup(
      [
        { date: "2026-03-01", amount: 0 },
        { date: "2026-04-01", amount: 0.001 },
        { date: "2026-05-01", amount: -0.001 },
      ],
      "2026-05-10",
    );
    expect(c.detected).toBe(false);
    expect(c.dropReason).toBe("amount_too_small");
  });

  it("drops inconsistent-amount groups as inconsistent", () => {
    const c = analyzeRecurringGroup(
      [
        { date: "2026-03-01", amount: -50 },
        { date: "2026-04-01", amount: -200 }, // 4x the others — beyond 20%
        { date: "2026-05-01", amount: -50 },
      ],
      "2026-05-10",
    );
    expect(c.detected).toBe(false);
    expect(c.dropReason).toBe("inconsistent");
  });

  it("detects a 30-day cadence and returns expected fields", () => {
    const c = analyzeRecurringGroup(
      [
        { date: "2026-03-01", amount: -50 },
        { date: "2026-04-01", amount: -50 },
        { date: "2026-05-01", amount: -50 },
      ],
      "2026-05-10",
    );
    expect(c.detected).toBe(true);
    expect(c.dropReason).toBeUndefined();
    expect(c.lastDate).toBe("2026-05-01");
    // Average of 31 days + 30 days = 30.5
    expect(c.expectedCadenceDays).toBeCloseTo(30.5, 1);
    expect(c.daysSinceLast).toBe(9);
  });

  it("flags stale at the 1.5x cadence boundary", () => {
    // Exercise isStale on a controlled cadence directly — the 1.5x
    // threshold gates "stale" not "detected", and is testable in isolation
    // without re-deriving cadence from a synthetic group.
    expect(isStale({
      lastDate: "2026-04-01",
      expectedCadenceDays: 30,
      daysSinceLast: 50,
      avg: -50,
      consistent: true,
      detected: true,
    })).toBe(true);
    expect(isStale({
      lastDate: "2026-04-01",
      expectedCadenceDays: 30,
      daysSinceLast: 45, // exactly 1.5x — NOT > threshold
      avg: -50,
      consistent: true,
      detected: true,
    })).toBe(false);
    expect(isStale({
      lastDate: "2026-04-01",
      expectedCadenceDays: 30,
      daysSinceLast: 46,
      avg: -50,
      consistent: true,
      detected: true,
    })).toBe(true);
  });

  it("isStale returns false for zero/negative cadence", () => {
    expect(isStale({
      lastDate: "2026-04-01",
      expectedCadenceDays: 0,
      daysSinceLast: 100,
      avg: -50,
      consistent: false,
      detected: false,
    })).toBe(false);
  });

  it("STALENESS_THRESHOLD_MULTIPLIER is exposed", () => {
    expect(STALENESS_THRESHOLD_MULTIPLIER).toBe(1.5);
  });
});
