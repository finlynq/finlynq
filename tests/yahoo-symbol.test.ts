import { describe, it, expect } from "vitest";
import { toYahooSymbol } from "@/lib/securities/yahoo-symbol";

describe("toYahooSymbol", () => {
  describe("US class shares — dot becomes a dash", () => {
    it.each([
      ["BRK.B", "BRK-B"],
      ["BRK.A", "BRK-A"],
      ["BF.B", "BF-B"],
      ["HEI.A", "HEI-A"],
      ["LEN.B", "LEN-B"],
    ])("%s → %s", (input, expected) => {
      expect(toYahooSymbol(input)).toBe(expected);
    });

    it("uppercases the class letter but leaves the root alone", () => {
      expect(toYahooSymbol("BRK.b")).toBe("BRK-B");
    });
  });

  describe("warrants — trailing + becomes -WT", () => {
    it.each([
      ["GME+", "GME-WT"],
      ["IONQ+", "IONQ-WT"],
    ])("%s → %s", (input, expected) => {
      expect(toYahooSymbol(input)).toBe(expected);
    });
  });

  // These are the load-bearing cases: Yahoo REQUIRES the dot for exchange
  // suffixes, so over-eager matching would take whole exchanges offline.
  describe("leaves non-class-share notation untouched", () => {
    it.each([
      "V3AA.L", // London — a single-letter suffix that is NOT a class share
      "SHOP.TO", // Toronto
      "BHP.AX", // Australia
      "SAP.DE", // Germany
      "AIR.PA", // Paris
      "0700.HK", // Hong Kong
      "BTC-USD", // crypto
      "VNDUSD=X", // FX
      "GC=F", // futures
      "^GSPC", // index
      "AAPL", // plain US equity
      "BRK-B", // already in Yahoo form — must be idempotent
      "GME-WT", // already in Yahoo form
    ])("%s is unchanged", (input) => {
      expect(toYahooSymbol(input)).toBe(input);
    });

    it("is idempotent for converted symbols", () => {
      expect(toYahooSymbol(toYahooSymbol("BRK.B"))).toBe("BRK-B");
      expect(toYahooSymbol(toYahooSymbol("GME+"))).toBe("GME-WT");
    });
  });

  describe("edge cases", () => {
    it("trims surrounding whitespace", () => {
      expect(toYahooSymbol("  BRK.B  ")).toBe("BRK-B");
    });

    it("returns empty input unchanged", () => {
      expect(toYahooSymbol("")).toBe("");
      expect(toYahooSymbol("   ")).toBe("");
    });

    it("does not treat a bare dot-suffix with no root as a class share", () => {
      expect(toYahooSymbol(".B")).toBe(".B");
    });

    it("prefers the warrant rule when both could apply", () => {
      expect(toYahooSymbol("BRK.B+")).toBe("BRK.B-WT");
    });
  });
});
