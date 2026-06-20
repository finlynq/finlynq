/**
 * FINLYNQ-204 — crypto parity for the 30-min today-row TTL.
 *
 * `getCryptoSpotPrices` (the VALUATION path used by dashboard / net-worth /
 * getHoldingsValueByAccount) must re-fetch a today crypto row older than the TTL
 * and overwrite it (stamping fetched_at), serve a younger one from cache, and
 * retain the stale value if the live CoinGecko fetch fails. Driven against an
 * in-memory `@/db` fake + a mocked global `fetch` (CoinGecko /coins/markets).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Row = {
  id: number;
  symbol: string;
  date: string;
  price: number;
  currency: string;
  previousClose: number | null;
  fetchedAt: Date | null;
};

type Pred =
  | { t: "eq"; col: unknown; val: unknown }
  | { t: "in"; col: unknown; vals: unknown[] }
  | { t: "and"; preds: Pred[] };

const H = vi.hoisted(() => {
  const store: { rows: Row[]; nextId: number } = { rows: [], nextId: 1 };
  const COL = {
    symbol: { __col: "symbol" },
    date: { __col: "date" },
    id: { __col: "id" },
  };
  function colName(col: unknown): keyof Row | null {
    if (col === COL.symbol) return "symbol";
    if (col === COL.date) return "date";
    if (col === COL.id) return "id";
    return null;
  }
  function matches(row: Row, p: Pred | undefined): boolean {
    if (!p) return true;
    if (p.t === "and") return p.preds.every((pp) => matches(row, pp));
    const name = colName(p.col);
    if (!name) return true;
    if (p.t === "eq") return (row as Record<string, unknown>)[name] === p.val;
    if (p.t === "in") return p.vals.includes((row as Record<string, unknown>)[name]);
    return true;
  }
  return { store, COL, matches };
});

const store = H.store;
function resetStore() {
  store.rows = [];
  store.nextId = 1;
}
function seed(r: Omit<Row, "id">): Row {
  const row: Row = { id: store.nextId++, ...r };
  store.rows.push(row);
  return row;
}

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown): Pred => ({ t: "eq", col, val }),
  and: (...preds: Pred[]): Pred => ({ t: "and", preds }),
  inArray: (col: unknown, vals: unknown[]): Pred => ({ t: "in", col, vals }),
}));

vi.mock("@/db", () => {
  const { store, COL, matches } = H;
  const priceCache = { symbol: COL.symbol, date: COL.date, id: COL.id };

  function makeSelect() {
    let pred: Pred | undefined;
    const chain = {
      from() {
        return chain;
      },
      where(p: Pred) {
        pred = p;
        return chain;
      },
      then(resolve: (rows: Row[]) => unknown) {
        return Promise.resolve(store.rows.filter((r) => matches(r, pred))).then(resolve);
      },
      async get() {
        return store.rows.find((r) => matches(r, pred)) ?? null;
      },
    };
    return chain;
  }
  function makeUpdate() {
    let patch: Partial<Row> = {};
    let pred: Pred | undefined;
    const chain = {
      set(p: Partial<Row>) {
        patch = p;
        return chain;
      },
      where(p: Pred) {
        pred = p;
        return chain;
      },
      returning() {
        const hit = store.rows.filter((r) => matches(r, pred));
        for (const r of hit) Object.assign(r, patch);
        return Promise.resolve(hit.map((r) => ({ id: r.id })));
      },
      then(resolve: (v: unknown) => unknown) {
        const hit = store.rows.filter((r) => matches(r, pred));
        for (const r of hit) Object.assign(r, patch);
        return Promise.resolve(undefined).then(resolve);
      },
    };
    return chain;
  }
  function makeInsert() {
    return {
      values(vals: Partial<Row> | Partial<Row>[]) {
        const arr = Array.isArray(vals) ? vals : [vals];
        for (const v of arr) {
          store.rows.push({
            id: store.nextId++,
            symbol: v.symbol!,
            date: v.date!,
            price: v.price ?? 0,
            currency: v.currency ?? "CAD",
            previousClose: v.previousClose ?? null,
            fetchedAt: v.fetchedAt ?? new Date(),
          });
        }
        return Promise.resolve(undefined);
      },
    };
  }
  const db = {
    select: () => makeSelect(),
    update: () => makeUpdate(),
    insert: () => makeInsert(),
  };
  return { db, schema: { priceCache } };
});

import { getCryptoSpotPrices } from "@/lib/crypto-service";
import { todayISO } from "@/lib/utils/date";

const TODAY = todayISO();
const ago = (ms: number) => new Date(Date.now() - ms);

// CoinGecko /coins/markets returns an array of coin objects.
function coingeckoMarkets(coins: Array<{ id: string; symbol: string; price: number }>) {
  return coins.map((c) => ({
    id: c.id,
    symbol: c.symbol.toLowerCase(),
    name: c.symbol.toUpperCase(),
    current_price: c.price,
    price_change_24h: 0,
    price_change_percentage_24h: 0,
    market_cap: 0,
    image: undefined,
  }));
}

describe("getCryptoSpotPrices — today-row TTL parity", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    resetStore();
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // tc-6 (younger): fresh today crypto row → cache hit, no live fetch.
  it("serves a fresh today crypto row from cache (no CoinGecko call)", async () => {
    seed({ symbol: "CRYPTO:BTC", date: TODAY, price: 88455, currency: "CAD", previousClose: null, fetchedAt: ago(5 * 60 * 1000) });

    const out = await getCryptoSpotPrices([{ coinId: "bitcoin", symbol: "BTC" }]);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.find((p) => p.symbol === "BTC")!.price).toBe(88455);
  });

  // tc-6 (older): stale today crypto row → re-fetch live & overwrite, fetched_at stamped.
  it("re-fetches and overwrites a stale today crypto row", async () => {
    const seeded = seed({ symbol: "CRYPTO:ETH", date: TODAY, price: 2396.64, currency: "CAD", previousClose: null, fetchedAt: ago(31 * 60 * 1000) });
    // Capture the original stamp by VALUE — the fake mutates the same row object
    // in place, so reading seeded.fetchedAt after the call would see the new stamp.
    const originalStamp = seeded.fetchedAt!.getTime();
    fetchSpy.mockResolvedValue({ ok: true, json: async () => coingeckoMarkets([{ id: "ethereum", symbol: "ETH", price: 2500 }]) });

    const out = await getCryptoSpotPrices([{ coinId: "ethereum", symbol: "ETH" }]);

    expect(fetchSpy).toHaveBeenCalledTimes(1); // live re-fetch issued
    expect(out.find((p) => p.symbol === "ETH")!.price).toBe(2500); // overwritten
    // Row UPDATEd in place: new price + fresh fetched_at, no duplicate inserted.
    const rows = store.rows.filter((r) => r.symbol === "CRYPTO:ETH" && r.date === TODAY);
    expect(rows).toHaveLength(1);
    expect(rows[0].price).toBe(2500);
    expect(rows[0].fetchedAt!.getTime()).toBeGreaterThan(originalStamp);
  });

  // retain-on-failure parity: stale today crypto row + live fetch fails → keep stale.
  it("retains the stale crypto price when the live fetch fails", async () => {
    seed({ symbol: "CRYPTO:SOL", date: TODAY, price: 96.96, currency: "CAD", previousClose: null, fetchedAt: ago(31 * 60 * 1000) });
    fetchSpy.mockResolvedValue({ ok: false, json: async () => ([]) }); // CoinGecko error

    const out = await getCryptoSpotPrices([{ coinId: "solana", symbol: "SOL" }]);

    const sol = out.find((p) => p.symbol === "SOL");
    expect(sol).toBeDefined(); // NOT dropped
    expect(sol!.price).toBe(96.96); // retained stale value
  });
});
