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
    expect(src).toMatch(/<div className="absolute inset-0">\s*<Sparkline data=\{nwSparkline\}[^>]*\bfill\b[^>]*domain=\{niceDomain\(nwSparkline/);
    expect(src).not.toMatch(/w-40 h-20 opacity-50/);
  });

  it("GH #446: hovering the line shows each month's value", () => {
    const src = read("src/app/(app)/dashboard/page.tsx");
    const hero = /<Sparkline data=\{nwSparkline\}[^>]*\/>/.exec(src)?.[0] ?? "";
    // labels turn the tooltip on; currency formats it.
    expect(hero).toContain("labels={nwSparkLabels}");
    expect(hero).toContain("currency={apiDisplayCurrency}");
    // The chart layer takes the mouse; the text layer above lets it through.
    expect(src).not.toMatch(/absolute inset-0 pointer-events-none/);
    expect(src).toContain('<CardContent className="relative pt-6 pb-6 px-6 pointer-events-none">');
    // No opacity on the wrapper: it would make a stacking context and put the
    // tooltip under the text. The opacity goes on the drawn area instead.
    expect(src).not.toMatch(/<div className="absolute inset-0 opacity-/);
    expect(hero).toMatch(/areaClassName="opacity-60/);
  });

  it("a fill chart keeps its tooltip inside the chart; stat tiles still escape upwards", () => {
    const src = read("src/components/sparkline.tsx");
    expect(src).toContain("allowEscapeViewBox={{ x: false, y: !fill }}");
    expect(src).toContain("reverseDirection={{ x: false, y: !fill }}");
    expect(src).toContain("className={areaClassName}");
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
