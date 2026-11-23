/**
 * GH #434: the dashboard Net Worth card draws its line across the whole tile,
 * behind the text, scaled to the data's own range so a month's change shows.
 * Stat-tile sparklines keep the fixed 30px height and the 0 floor.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { niceDomain } from "@/lib/chart-series";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("net worth card background line", () => {
  it("fills the tile, behind the content, with the data's own range", () => {
    const src = read("src/app/(app)/dashboard/page.tsx");
    expect(src).toMatch(/<div className="absolute inset-0 pointer-events-none[^"]*">\s*<Sparkline data=\{nwSparkline\}[^>]*\bfill\b[^>]*domain=\{niceDomain\(nwSparkline/);
    expect(src).not.toMatch(/w-40 h-20 opacity-50/);
  });

  it("a 2.7% drop on a six-figure balance spans most of the chart height", () => {
    const values = [560000, 575000, 559500];
    const [lo, hi] = niceDomain(values, { padPct: 0.15, clampZeroFloor: false });
    const drop = (575000 - 559500) / (hi - lo);
    expect(drop).toBeGreaterThan(0.7);
    // From 0, the same drop was under 3% of the height.
    expect((575000 - 559500) / 575000).toBeLessThan(0.03);
  });

  it("stat-tile sparklines keep the fixed height and the 0 floor by default", () => {
    const src = read("src/components/sparkline.tsx");
    expect(src).toContain('fill ? "w-full h-full" : "w-full h-[30px]"');
    expect(src).toContain("{domain && <YAxis hide domain={domain} />}");
  });
});
