/**
 * The ticker lookups follow the "Crypto asset" box (GH #395 follow-up).
 *
 * PAXG is both a coin (PAX Gold) and a stock on Yahoo (Pine Tree Acquisition
 * Corp.). It is priced as the coin only when the holding's box is ticked, so
 * the lookups that fill in the Add security dialog and the holding form must
 * describe it the same way: the stock unticked, the coin ticked. A ticker on
 * the name-alone list (BTC, ...) is always priced as the coin, so it is always
 * described as one.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({
    authenticated: true,
    context: { userId: "u1", method: "account", mfaVerified: false, dek: null, sessionId: "s1" },
  })),
}));

// symbol-info reads the user's active currencies before asking Yahoo: none.
vi.mock("@/db", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "from", "where", "limit", "orderBy"]) chain[m] = () => chain;
  chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve);
  return {
    db: new Proxy({}, { get: (_t, prop) => chain[prop as string] }),
    schema: new Proxy({}, { get: () => new Proxy({}, { get: () => ({}) }) }),
  };
});

const fetchQuoteLive = vi.fn();
const fetchQuote = vi.fn();
vi.mock("@/lib/price-service", () => ({
  fetchQuoteLive: (s: string) => fetchQuoteLive(s),
  fetchQuote: (s: string) => fetchQuote(s),
}));

const getCryptoPrice = vi.fn();
vi.mock("@/lib/crypto-service", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/crypto-service")>();
  return { ...real, getCryptoPrice: (id: string) => getCryptoPrice(id) };
});

import { GET as lookup } from "@/app/api/securities/lookup/route";
import { GET as symbolInfo } from "@/app/api/portfolio/symbol-info/route";
import { pricedAsCrypto } from "@/lib/fx/supported-currencies";
import { createMockRequest } from "./helpers/api-test-utils";

const pineTree = { price: 9.83, currency: "USD", name: "Pine Tree Acquisition Corp." };

beforeEach(() => {
  fetchQuoteLive.mockReset().mockImplementation(async (s: string) => (s === "PAXG" ? pineTree : null));
  fetchQuote.mockReset().mockImplementation(async (s: string) => (s === "PAXG" ? pineTree : null));
  getCryptoPrice.mockReset().mockImplementation(async (id: string) =>
    id === "pax-gold"
      ? { id, symbol: "PAXG", name: "PAX Gold", price: 4061, currency: "USD" }
      : id === "bitcoin"
        ? { id, symbol: "BTC", name: "Bitcoin", price: 100000, currency: "USD" }
        : null,
  );
});

async function json(res: Response) {
  const body = await res.json();
  return body.data ?? body;
}

describe("pricedAsCrypto", () => {
  it("follows the box for a ticker that is also a stock", () => {
    expect(pricedAsCrypto("PAXG", false)).toBe(false);
    expect(pricedAsCrypto("PAXG", true)).toBe(true);
    expect(pricedAsCrypto("AAPL", false)).toBe(false);
  });

  it("is always true for a ticker on the name-alone list", () => {
    expect(pricedAsCrypto("BTC", false)).toBe(true);
    expect(pricedAsCrypto("btc-usd", false)).toBe(true);
  });
});

describe("Add security lookup", () => {
  it("describes an unticked PAXG as the stock", async () => {
    const res = await lookup(createMockRequest("http://localhost/api/securities/lookup?symbol=PAXG"));
    expect(await json(res)).toMatchObject({ found: true, name: "Pine Tree Acquisition Corp.", isCrypto: false });
    expect(getCryptoPrice).not.toHaveBeenCalled();
  });

  it("describes a ticked PAXG as the coin", async () => {
    const res = await lookup(createMockRequest("http://localhost/api/securities/lookup?symbol=PAXG&crypto=1"));
    expect(await json(res)).toMatchObject({ found: true, name: "PAX Gold", currency: "USD", isCrypto: true });
    expect(fetchQuoteLive).not.toHaveBeenCalled();
  });

  it("still describes BTC as the coin with the box unticked", async () => {
    const res = await lookup(createMockRequest("http://localhost/api/securities/lookup?symbol=BTC"));
    expect(await json(res)).toMatchObject({ found: true, name: "Bitcoin", isCrypto: true });
  });
});

describe("holding form symbol-info", () => {
  it("describes an unticked PAXG as the stock", async () => {
    const res = await symbolInfo(createMockRequest("http://localhost/api/portfolio/symbol-info?symbol=PAXG"));
    expect(await res.json()).toMatchObject({ kind: "stock", isCrypto: false, source: "yahoo" });
  });

  it("describes a ticked PAXG as the coin", async () => {
    const res = await symbolInfo(createMockRequest("http://localhost/api/portfolio/symbol-info?symbol=PAXG&crypto=1"));
    expect(await res.json()).toMatchObject({ kind: "crypto", currency: "USD", isCrypto: true, source: "coingecko" });
    expect(fetchQuote).not.toHaveBeenCalled();
  });

  it("says when a ticked ticker is not a coin we price, without asking Yahoo", async () => {
    const res = await symbolInfo(createMockRequest("http://localhost/api/portfolio/symbol-info?symbol=NOTACOIN&crypto=1"));
    expect(await res.json()).toMatchObject({ kind: "crypto", isCrypto: true, source: "none", currency: null });
    expect(fetchQuote).not.toHaveBeenCalled();
  });
});
