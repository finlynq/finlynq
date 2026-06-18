/**
 * Pure-unit tests for buildStackedSeries (FINLYNQ-129 — chart stacked-member
 * toggle). Builds on the FINLYNQ-128 BreakdownMember shape; the gating
 * invariant is that the stacked bands re-sum to the aggregate `total` at every
 * point (the outer stack boundary equals the aggregate line — tc-1/tc-2/tc-3).
 *
 * Self-contained: buildStackedSeries depends only on the static chart palette,
 * so no harness bootstrap.
 */

import { describe, it, expect } from "vitest";
import {
  buildStackedSeries,
  OTHER_STACK_KEY,
  POSITIVE_STACK_ID,
  NEGATIVE_STACK_ID,
  type StackPoint,
} from "@/lib/chart-stack";
import type { BreakdownMember } from "@/lib/chart-breakdown";

const m = (id: number, name: string, value: number): BreakdownMember => ({ id, name, value });

/** Sum every numeric band on a row (excludes the date string). */
function rowBandSum(row: Record<string, string | number>): number {
  return Object.entries(row)
    .filter(([k]) => k !== "date")
    .reduce((s, [, v]) => s + (typeof v === "number" ? v : 0), 0);
}

describe("buildStackedSeries", () => {
  it("emits one row per point with the date under the default dateKey", () => {
    const points: StackPoint[] = [
      { date: "2026-01-01", total: 30, members: [m(1, "A", 10), m(2, "B", 20)] },
      { date: "2026-01-02", total: 40, members: [m(1, "A", 15), m(2, "B", 25)] },
    ];
    const { rows } = buildStackedSeries(points);
    expect(rows).toHaveLength(2);
    expect(rows[0].date).toBe("2026-01-01");
    expect(rows[1].date).toBe("2026-01-02");
  });

  it("preserves the aggregate: band sum equals total at every point (no Other)", () => {
    const points: StackPoint[] = [
      { date: "d1", total: 30, members: [m(1, "A", 10), m(2, "B", 20)] },
      { date: "d2", total: 50, members: [m(1, "A", 30), m(2, "B", 20)] },
    ];
    const { rows, legend } = buildStackedSeries(points, { maxMembers: 10 });
    expect(legend.some((l) => l.isOther)).toBe(false);
    expect(rowBandSum(rows[0])).toBeCloseTo(30, 6);
    expect(rowBandSum(rows[1])).toBeCloseTo(50, 6);
  });

  it("collapses members past maxMembers into a signed Other residual that ties to total", () => {
    // 13 members; top-10 kept, tail (3) → Other.
    const members = Array.from({ length: 13 }, (_, i) => m(i, `m${i}`, i + 1));
    const total = members.reduce((s, x) => s + x.value, 0); // 91
    const { rows, legend } = buildStackedSeries([{ date: "d1", total, members }], {
      maxMembers: 10,
    });
    const other = legend.find((l) => l.isOther);
    expect(other).toBeDefined();
    expect(legend.filter((l) => !l.isOther)).toHaveLength(10);
    // Outer stack boundary equals the aggregate at this point.
    expect(rowBandSum(rows[0])).toBeCloseTo(total, 6);
    // The residual key carries the signed remainder (1+2+3 = 6).
    expect(rows[0][OTHER_STACK_KEY]).toBeCloseTo(6, 6);
  });

  it("ranks bands by average absolute contribution across the whole window", () => {
    // B dominates on average even though A leads on the first point.
    const points: StackPoint[] = [
      { date: "d1", total: 30, members: [m(1, "A", 25), m(2, "B", 5)] },
      { date: "d2", total: 200, members: [m(1, "A", 5), m(2, "B", 195)] },
    ];
    const { legend } = buildStackedSeries(points, { maxMembers: 1 });
    // maxMembers=1 → only the top-ranked member named; the rest → Other.
    expect(legend[0].name).toBe("B");
    expect(legend.some((l) => l.isOther)).toBe(true);
  });

  it("seeds absent members to 0 so a band stays flat on a gap (no dropped series)", () => {
    const points: StackPoint[] = [
      { date: "d1", total: 30, members: [m(1, "A", 10), m(2, "B", 20)] },
      { date: "d2", total: 20, members: [m(2, "B", 20)] }, // A absent
    ];
    const { rows, legend } = buildStackedSeries(points, { maxMembers: 10 });
    const aKey = legend.find((l) => l.name === "A")!.key;
    expect(rows[1][aKey]).toBe(0);
    expect(rowBandSum(rows[1])).toBeCloseTo(20, 6);
  });

  it("honours a custom dateKey and otherLabel", () => {
    const members = Array.from({ length: 12 }, (_, i) => m(i, `m${i}`, i + 1));
    const total = members.reduce((s, x) => s + x.value, 0);
    const { rows, legend } = buildStackedSeries([{ date: "2026-03", total, members }], {
      maxMembers: 10,
      dateKey: "month",
      otherLabel: "Everything else",
    });
    expect(rows[0].month).toBe("2026-03");
    expect(legend.find((l) => l.isOther)!.name).toBe("Everything else");
  });

  it("keys members by id so same-name distinct ids stay separate bands", () => {
    const points: StackPoint[] = [
      {
        date: "d1",
        total: 30,
        members: [m(1, "Cash", 10), m(2, "Cash", 20)],
      },
    ];
    const { legend } = buildStackedSeries(points, { maxMembers: 10 });
    // Two distinct ids → two bands even though the names collide.
    expect(legend.filter((l) => !l.isOther)).toHaveLength(2);
  });

  it("returns empty rows + empty legend for no points", () => {
    const { rows, legend } = buildStackedSeries([]);
    expect(rows).toEqual([]);
    expect(legend).toEqual([]);
  });

  // ── FINLYNQ-187 — sign-split (Net Worth "By account" liabilities below axis) ──
  describe("signSplit (FINLYNQ-187)", () => {
    it("tc-2: keeps the liability member NEGATIVE and reconciles net to 500000", () => {
      // Net Worth: one grid point — assets +800000, mortgage −300000 → net 500000.
      const points: StackPoint[] = [
        {
          date: "2026-06-01",
          total: 500000,
          members: [m(1, "Assets", 800000), m(2, "Mortgage", -300000)],
        },
      ];
      const { rows, legend } = buildStackedSeries(points, {
        maxMembers: 10,
        signSplit: true,
      });

      const assets = legend.find((l) => l.name === "Assets")!;
      const mortgage = legend.find((l) => l.name === "Mortgage")!;

      // Liabilities land in the below-axis stack, assets in the above-axis stack.
      expect(assets.stackId).toBe(POSITIVE_STACK_ID);
      expect(mortgage.stackId).toBe(NEGATIVE_STACK_ID);

      // Signed members are PRESERVED (not abs-valued): the mortgage band is −300000.
      expect(rows[0][mortgage.key]).toBeCloseTo(-300000, 6);
      expect(rows[0][assets.key]).toBeCloseTo(800000, 6);

      // Reconciled net (top of positive stack − bottom of negative stack) = Σ bands
      // = 800000 + (−300000) = 500000 == aggregate total.
      expect(rowBandSum(rows[0])).toBeCloseTo(500000, 6);
    });

    it("classifies a sign-flipping member by its NET window sign (stays below axis)", () => {
      // A liability that briefly dips positive on one point but is net-negative
      // over the window must still land in the below-axis stack.
      const points: StackPoint[] = [
        { date: "d1", total: 100, members: [m(1, "Asset", 200), m(2, "Loan", -100)] },
        { date: "d2", total: 280, members: [m(1, "Asset", 250), m(2, "Loan", 30)] },
      ];
      const { rows, legend } = buildStackedSeries(points, { signSplit: true });
      const loan = legend.find((l) => l.name === "Loan")!;
      // Net Loan contribution = −100 + 30 = −70 < 0 → below-axis.
      expect(loan.stackId).toBe(NEGATIVE_STACK_ID);
      // Per-point signed values are untouched, so each point still reconciles.
      expect(rowBandSum(rows[0])).toBeCloseTo(100, 6);
      expect(rowBandSum(rows[1])).toBeCloseTo(280, 6);
    });

    it("routes a net-negative Other residual into the below-axis stack and still reconciles", () => {
      // 2 big assets kept; a tail of small liabilities collapses into Other with a
      // net-negative residual → below-axis. Net still ties to total.
      const points: StackPoint[] = [
        {
          date: "d1",
          total: 500,
          members: [
            m(1, "AssetA", 600),
            m(2, "AssetB", 400),
            m(3, "Lien1", -200),
            m(4, "Lien2", -300),
          ],
        },
      ];
      const { rows, legend } = buildStackedSeries(points, {
        maxMembers: 2,
        signSplit: true,
      });
      const other = legend.find((l) => l.isOther)!;
      // Residual = total − (AssetA + AssetB) = 500 − 1000 = −500 → below-axis.
      expect(other.stackId).toBe(NEGATIVE_STACK_ID);
      expect(rows[0][OTHER_STACK_KEY]).toBeCloseTo(-500, 6);
      expect(rowBandSum(rows[0])).toBeCloseTo(500, 6);
    });

    it("tc-2b: all-same-sign output is byte-identical with vs without signSplit (no-op for Income/Expenses + Performance)", () => {
      // Mirrors how the same-sign charts call buildStackedSeries: 12 positive
      // members so an Other band exists too. The ONLY difference must be the new
      // optional `stackId` field — rows + every other legend field unchanged.
      const members = Array.from({ length: 12 }, (_, i) => m(i, `cat${i}`, i + 1));
      const total = members.reduce((s, x) => s + x.value, 0);
      const pts: StackPoint[] = [{ date: "2026-03", total, members }];

      const legacy = buildStackedSeries(pts, { maxMembers: 10 });
      const split = buildStackedSeries(pts, { maxMembers: 10, signSplit: true });

      // Rows are byte-identical (no value or key change).
      expect(split.rows).toEqual(legacy.rows);

      // Legacy legend carries NO stackId at all (undefined) — same-sign callers
      // keep their own literal stackId and never read this field.
      for (const b of legacy.legend) expect(b.stackId).toBeUndefined();

      // Stripping the new optional field reproduces the legacy legend exactly.
      const stripped = split.legend.map(({ stackId, ...rest }) => {
        void stackId;
        return rest;
      });
      expect(stripped).toEqual(legacy.legend);

      // And every same-sign band lands in the positive (above-axis) stack.
      for (const b of split.legend) expect(b.stackId).toBe(POSITIVE_STACK_ID);
    });
  });
});
