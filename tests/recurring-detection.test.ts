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

  // GH #307 (Problem 3) — interval-regularity + bimodal-amount scoring.
  it("detects a constant biweekly cadence (single-amount, passes)", () => {
    const c = analyzeRecurringGroup(
      [
        { date: "2026-05-01", amount: 1500 },
        { date: "2026-05-15", amount: 1500 },
        { date: "2026-05-29", amount: 1500 },
      ],
      "2026-06-05",
    );
    expect(c.detected).toBe(true);
    expect(c.dropReason).toBeUndefined();
    expect(c.consistent).toBe(true);
    expect(c.expectedCadenceDays).toBeCloseTo(14, 1);
    expect(c.avg).toBeCloseTo(1500, 2);
  });

  it("detects a regular biweekly paycheck alternating two amounts >=1.5x apart (GH #307)", () => {
    // Base pay 2000 / boosted 3200 (1.6x apart) — flattened to one mean this
    // would fall outside the +/-20% band and drop as `inconsistent`. Now the
    // regular cadence + two tight clusters is recognized, projected off the
    // MOST-RECENT cluster (last occurrence is 3200).
    const c = analyzeRecurringGroup(
      [
        { date: "2026-04-03", amount: 2000 },
        { date: "2026-04-17", amount: 3200 },
        { date: "2026-05-01", amount: 2000 },
        { date: "2026-05-15", amount: 3200 },
        { date: "2026-05-29", amount: 2000 },
        { date: "2026-06-12", amount: 3200 },
      ],
      "2026-06-20",
    );
    expect(c.detected).toBe(true);
    expect(c.dropReason).toBeUndefined();
    expect(c.consistent).toBe(true);
    expect(c.expectedCadenceDays).toBeCloseTo(14, 1);
    // Projects the most-recent cluster's mean (3200), NOT the blended 2600.
    expect(c.avg).toBeCloseTo(3200, 2);
    // A fresh recurrence, not stale.
    expect(isStale(c)).toBe(false);
  });

  it("projects the most-recent cluster when the latest occurrence is the lower amount (GH #307)", () => {
    const c = analyzeRecurringGroup(
      [
        { date: "2026-04-17", amount: 3200 },
        { date: "2026-05-01", amount: 2000 },
        { date: "2026-05-15", amount: 3200 },
        { date: "2026-05-29", amount: 2000 },
      ],
      "2026-06-05",
    );
    expect(c.detected).toBe(true);
    expect(c.avg).toBeCloseTo(2000, 2); // last occurrence (05-29) is 2000
  });

  it("still drops a single spike among constant amounts as inconsistent (not bimodal)", () => {
    // Four identical + one 4x outlier: the minority cluster is a single row,
    // so it stays an outlier (dropped), not a two-amount recurrence.
    const c = analyzeRecurringGroup(
      [
        { date: "2026-02-01", amount: -50 },
        { date: "2026-03-01", amount: -50 },
        { date: "2026-04-01", amount: -50 },
        { date: "2026-05-01", amount: -200 },
        { date: "2026-06-01", amount: -50 },
      ],
      "2026-06-10",
    );
    expect(c.detected).toBe(false);
    expect(c.dropReason).toBe("inconsistent");
  });

  it("drops genuinely irregular discretionary spend as inconsistent (GH #307)", () => {
    // Scattered amounts AND irregular cadence — fails both the single-mean band
    // and the regular-bimodal path.
    const c = analyzeRecurringGroup(
      [
        { date: "2026-03-02", amount: -12 },
        { date: "2026-03-19", amount: -85 },
        { date: "2026-04-05", amount: -40 },
        { date: "2026-04-09", amount: -150 },
        { date: "2026-05-20", amount: -33 },
      ],
      "2026-05-25",
    );
    expect(c.detected).toBe(false);
    expect(c.dropReason).toBe("inconsistent");
  });

  it("keeps a bimodal-regular but long-dormant income detectable-yet-stale (GH #307)", () => {
    // Two-amount biweekly that stopped 100+ days ago: analyzeRecurringGroup
    // still recognizes it as a real recurrence (detected), and the consumer's
    // isStale gate is what drops it as `stale` — bimodal scoring must not
    // swallow the staleness signal.
    const c = analyzeRecurringGroup(
      [
        { date: "2026-01-02", amount: 2000 },
        { date: "2026-01-16", amount: 3200 },
        { date: "2026-01-30", amount: 2000 },
        { date: "2026-02-13", amount: 3200 },
      ],
      "2026-06-20",
    );
    expect(c.detected).toBe(true);
    expect(isStale(c)).toBe(true);
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
