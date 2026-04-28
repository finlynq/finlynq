import { describe, it, expect } from "vitest";
import {
  getTFSALimit, getTotalTFSARoom, getRRSPRoom, getRESPGrant,
  getAssetLocationAdvice, getMarginalRate, rrspVsTfsa,
} from "@/lib/tax-optimizer";

describe("getTFSALimit", () => {
  it("returns correct limits for known years", () => {
    expect(getTFSALimit(2009)).toBe(5000);
    expect(getTFSALimit(2015)).toBe(10000);
    expect(getTFSALimit(2023)).toBe(6500);
    expect(getTFSALimit(2024)).toBe(7000);
  });

  it("defaults to 7000 for unknown future years", () => {
    expect(getTFSALimit(2030)).toBe(7000);
  });
});

describe("getTotalTFSARoom", () => {
  it("calculates total TFSA room from 2009 to 2026", () => {
    const total = getTotalTFSARoom(2009, 2026);
    expect(total).toBeGreaterThan(100000);
  });

  it("handles single year range", () => {
    expect(getTotalTFSARoom(2024, 2024)).toBe(7000);
  });
});

describe("getRRSPRoom", () => {
  it("calculates 18% of income up to limit", () => {
    expect(getRRSPRoom(100000, 0)).toBe(18000);
  });

  it("caps at annual RRSP limit", () => {
    expect(getRRSPRoom(200000, 0)).toBe(31560);
  });

  it("subtracts previous year usage", () => {
    expect(getRRSPRoom(100000, 10000)).toBe(8000);
  });

  it("returns 0 when fully used", () => {
    expect(getRRSPRoom(100000, 20000)).toBe(0);
  });
});

describe("getRESPGrant", () => {
  it("gives 20% on contributions", () => {
    expect(getRESPGrant(2500)).toBe(500);
  });

  it("caps at $500", () => {
    expect(getRESPGrant(5000)).toBe(500);
  });

  it("handles small contributions", () => {
    expect(getRESPGrant(1000)).toBe(200);
  });
});

describe("getAssetLocationAdvice", () => {
  it("recommends US ETFs in RRSP", () => {
    const holdings = [
      { name: "Vanguard US Total", symbol: "VUN.TO", accountName: "TFSA", accountType: "A" },
    ];
    const advice = getAssetLocationAdvice(holdings);
    expect(advice.length).toBe(1);
    expect(advice[0].recommendedAccountType).toBe("RRSP");
  });

  it("recommends Canadian ETFs outside RRSP", () => {
    const holdings = [
      { name: "Vanguard Canada", symbol: "VCN.TO", accountName: "RRSP", accountType: "A" },
    ];
    const advice = getAssetLocationAdvice(holdings);
    expect(advice.length).toBe(1);
    expect(advice[0].recommendedAccountType).toContain("TFSA");
  });

  it("returns empty for optimal allocation", () => {
    const holdings = [
      { name: "VUN", symbol: "VUN.TO", accountName: "RRSP", accountType: "A" },
    ];
    expect(getAssetLocationAdvice(holdings)).toEqual([]);
  });

  it("skips holdings without symbols", () => {
    const holdings = [
      { name: "Cash", symbol: "", accountName: "TFSA", accountType: "A" },
    ];
    expect(getAssetLocationAdvice(holdings)).toEqual([]);
  });
});

describe("getMarginalRate", () => {
  it("returns correct rates for different income levels", () => {
    const rate50k = getMarginalRate(50000);
    expect(rate50k.federal).toBe(15);
    expect(rate50k.provincial).toBe(5.05);

    const rate100k = getMarginalRate(100000);
    expect(rate100k.federal).toBe(20.5);
    expect(rate100k.provincial).toBe(9.15);

    const rate200k = getMarginalRate(200000);
    expect(rate200k.federal).toBe(29);
    expect(rate200k.provincial).toBe(12.16);
  });

  it("combined rate equals federal + provincial", () => {
    const rate = getMarginalRate(80000);
    expect(rate.combined).toBe(rate.federal + rate.provincial);
  });
});

describe("rrspVsTfsa", () => {
  it("recommends RRSP for high income", () => {
    const result = rrspVsTfsa(150000, 10000);
    expect(result.recommendation).toContain("RRSP");
    expect(result.rrspBenefit).toBeGreaterThan(0);
  });

  it("recommends TFSA for lower income", () => {
    const result = rrspVsTfsa(40000, 5000);
    expect(result.recommendation).toContain("TFSA");
  });

  it("calculates correct RRSP benefit", () => {
    const rate = getMarginalRate(100000);
    const result = rrspVsTfsa(100000, 10000);
    expect(result.rrspBenefit).toBe(Math.round(10000 * (rate.combined / 100) * 100) / 100);
  });
});
