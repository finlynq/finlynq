/**
 * ISIN support (GH #365): recognise a valid ISIN, resolve it to the Yahoo
 * symbol it trades under, and use that symbol wherever a ticker is entered.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const marketFetch = vi.fn();
vi.mock("@/lib/market-fetch", () => ({ marketFetch: (...a: unknown[]) => marketFetch(...a) }));

import { isIsin, normalizeIsin } from "@/lib/securities/isin";
import { pickIsinQuote, resolveIsin, resolveTickerInput } from "@/lib/securities/isin-resolve";

const read = (rel: string) => readFileSync(path.resolve(__dirname, "..", rel), "utf8");
const okJson = (body: unknown) => ({ ok: true, json: async () => body });

beforeEach(() => {
  marketFetch.mockReset();
  (globalThis as { __pfIsinCache?: Map<string, unknown> }).__pfIsinCache?.clear();
});

describe("isIsin", () => {
  it.each([
    "US0378331005", // Apple
    "INE002A01018", // Reliance Industries
    "INF209K01YN0", // an Indian mutual fund (no exchange ticker)
    "GB0002634946", // BAE Systems
    " us0378331005 ", // case and whitespace are normalized
  ])("accepts %j", (s) => expect(isIsin(s)).toBe(true));

  it.each([
    "US0378331006", // wrong check digit
    "US037833100", // too short
    "0S0378331005", // country must be letters
    "ABCDEFGHIJKL", // 12-char ticker-shaped, fails the checksum shape
    "AAPL",
    "",
    null,
  ])("rejects %j", (s) => expect(isIsin(s)).toBe(false));

  it("normalizes to upper case", () => {
    expect(normalizeIsin(" ine002a01018 ")).toBe("INE002A01018");
  });
});

describe("pickIsinQuote", () => {
  it("takes the first holdable quote and prefers the long name", () => {
    expect(
      pickIsinQuote([
        { symbol: "RELI.FUT", quoteType: "FUTURE" },
        { symbol: "RELIANCE.NS", quoteType: "EQUITY", exchange: "NSI", shortname: "RELIANCE INDS", longname: "Reliance Industries Limited" },
      ]),
    ).toEqual({ symbol: "RELIANCE.NS", name: "Reliance Industries Limited", quoteType: "EQUITY", exchange: "NSI" });
  });

  it("drops a name that just repeats the symbol (Yahoo does this for funds)", () => {
    expect(pickIsinQuote([{ symbol: "0P0000XVYH.BO", quoteType: "MUTUALFUND", shortname: "0P0000XVYH.BO" }])?.name).toBeNull();
  });

  it("returns null when nothing is holdable", () => {
    expect(pickIsinQuote([{ symbol: "X", quoteType: "OPTION" }, { quoteType: "EQUITY" }])).toBeNull();
    expect(pickIsinQuote(undefined)).toBeNull();
  });
});

describe("resolveIsin", () => {
  it("never calls Yahoo for something that isn't an ISIN", async () => {
    expect(await resolveIsin("AAPL")).toBeNull();
    expect(marketFetch).not.toHaveBeenCalled();
  });

  it("resolves through Yahoo search, bypassing Next's fetch cache, and caches the hit", async () => {
    marketFetch.mockResolvedValue(okJson({ quotes: [{ symbol: "0P0000XVYH.BO", quoteType: "MUTUALFUND" }] }));
    const first = await resolveIsin("inf209k01yn0");
    const second = await resolveIsin("INF209K01YN0");
    expect(first?.symbol).toBe("0P0000XVYH.BO");
    expect(second).toEqual(first);
    expect(marketFetch).toHaveBeenCalledTimes(1);
    const [url, init] = marketFetch.mock.calls[0];
    expect(url).toContain("/v1/finance/search?q=INF209K01YN0");
    expect(init.cache).toBe("no-store");
  });

  it("does not cache a network failure, so the next attempt retries", async () => {
    marketFetch.mockRejectedValueOnce(new Error("timeout"));
    expect(await resolveIsin("US0378331005")).toBeNull();
    marketFetch.mockResolvedValueOnce(okJson({ quotes: [{ symbol: "AAPL", quoteType: "EQUITY" }] }));
    expect((await resolveIsin("US0378331005"))?.symbol).toBe("AAPL");
  });
});

describe("resolveTickerInput", () => {
  it("swaps a resolvable ISIN for its symbol and reports where it came from", async () => {
    marketFetch.mockResolvedValue(okJson({ quotes: [{ symbol: "RELIANCE.NS", quoteType: "EQUITY", longname: "Reliance Industries Limited" }] }));
    expect(await resolveTickerInput(" INE002A01018 ")).toEqual({
      symbol: "RELIANCE.NS",
      resolvedFromIsin: "INE002A01018",
      name: "Reliance Industries Limited",
    });
  });

  it("returns anything else unchanged", async () => {
    expect(await resolveTickerInput(" VCN.TO ")).toEqual({ symbol: "VCN.TO", resolvedFromIsin: null, name: null });
  });
});

describe("ISIN entry points are wired", () => {
  it("symbol-info resolves an ISIN before the crypto / currency / ticker checks", () => {
    const src = read("src/app/api/portfolio/symbol-info/route.ts");
    const isinAt = src.indexOf("if (isIsin(symbol))");
    expect(isinAt).toBeGreaterThan(-1);
    expect(isinAt).toBeLessThan(src.indexOf("symbolToCoinGeckoId(symbol)"));
    expect(src).toMatch(/resolvedFromIsin: symbol/);
  });

  it("the securities lookup resolves an ISIN and returns the symbol to use", () => {
    const src = read("src/app/api/securities/lookup/route.ts");
    expect(src).toMatch(/if \(isIsin\(symbol\)\)/);
    expect(src).toMatch(/symbol: match\.symbol/);
  });

  it("MCP manage_holdings add and update both resolve through resolveTickerInput", () => {
    const src = read("mcp-server/tools/portfolio.ts");
    expect(src.match(/await resolveTickerInput\(/g)?.length ?? 0).toBe(2);
  });

  it("both UI forms swap the resolved symbol into the field", () => {
    expect(read("src/components/holdings/holding-edit-form.tsx")).toMatch(/symbol: resolved,/);
    expect(read("src/app/(app)/settings/investments/page.tsx")).toMatch(/setAddSymbol\(d\.symbol\)/);
  });
});
