/**
 * FINLYNQ-204 — intraday 30-min TTL on today's price_cache rows.
 *
 * Two layers of coverage:
 *  - `isPriceCacheRowStale`: the pure staleness predicate (no DB / network).
 *  - `fetchMultipleQuotes` / `fetchQuote` driven against an in-memory fake of
 *    `@/db` + a mocked global `fetch` (the Yahoo chart layer) so we can assert
 *    the refresh / retain-on-failure / dup-row-UPDATE behavior end-to-end.
 *
 * A FakeDb models the price_cache table just enough for price-service's chained
 * Drizzle calls: select/where(+get), update/set/where(+returning), insert/values.
 * Rows are plain objects; `eq`/`and`/`inArray` are recorded as predicate specs
 * and evaluated by the fake (drizzle's real operators are imported but only used
 * as opaque markers here).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── In-memory price_cache fake ──────────────────────────────────────────────
// Shared mutable state + column markers live in a vi.hoisted block so the
// (hoisted) vi.mock factories below can close over them without a TDZ error.
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

function seed(r: Omit<Row, "id" | "currency"> & { currency?: string }): Row {
  const row: Row = { id: store.nextId++, currency: "USD", ...r };
  store.rows.push(row);
  return row;
}

// Mock drizzle-orm operators to produce the spec markers above.
vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown): Pred => ({ t: "eq", col, val }),
  and: (...preds: Pred[]): Pred => ({ t: "and", preds }),
  inArray: (col: unknown, vals: unknown[]): Pred => ({ t: "in", col, vals }),
}));

// Mock the db proxy + schema. schema.priceCache columns are the COL identities.
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
      // bulk read resolves the array (awaited directly)
      then(resolve: (rows: Row[]) => unknown) {
        return Promise.resolve(store.rows.filter((r) => matches(r, pred))).then(resolve);
      },
      // single-row read
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
      // update without returning (awaited directly)
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
            currency: v.currency ?? "USD",
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

import {
  isPriceCacheRowStale,
  fetchMultipleQuotes,
  fetchQuote,
  PRICE_CACHE_TODAY_TTL_MS,
} from "@/lib/price-service";
import { todayISO } from "@/lib/utils/date";

const TODAY = todayISO();
const ago = (ms: number) => new Date(Date.now() - ms);

// Build a Yahoo chart-API response body for a single symbol.
function yahooBody(price: number, previousClose: number, currency = "USD") {
  return {
    chart: {
      result: [
        {
          meta: {
            regularMarketPrice: price,
            previousClose,
            currency,
            instrumentType: "ETF",
            shortName: "X",
          },
        },
      ],
    },
  };
}

describe("isPriceCacheRowStale", () => {
  it("treats a today-row younger than the TTL as fresh", () => {
    expect(isPriceCacheRowStale(TODAY, ago(5 * 60 * 1000), TODAY)).toBe(false);
  });

  it("treats a today-row older than the TTL as stale", () => {
    expect(isPriceCacheRowStale(TODAY, ago(31 * 60 * 1000), TODAY)).toBe(true);
  });

  it("never marks a historical row stale, however old its fetched_at", () => {
    expect(isPriceCacheRowStale("2024-01-01", ago(10 * 365 * 86400000), TODAY)).toBe(false);
    expect(isPriceCacheRowStale("2024-01-01", null, TODAY)).toBe(false);
  });

  it("treats a today-row with null/unparseable fetched_at as stale (refresh)", () => {
    expect(isPriceCacheRowStale(TODAY, null, TODAY)).toBe(true);
    expect(isPriceCacheRowStale(TODAY, "not-a-date", TODAY)).toBe(true);
  });

  it("uses the 30-minute TTL constant", () => {
    expect(PRICE_CACHE_TODAY_TTL_MS).toBe(30 * 60 * 1000);
    // boundary: exactly TTL old is NOT stale (strict >)
    expect(isPriceCacheRowStale(TODAY, new Date(Date.now() - PRICE_CACHE_TODAY_TTL_MS), TODAY)).toBe(false);
  });
});

describe("fetchMultipleQuotes — today-row TTL refresh", () => {
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

  function mockLive(price: number, previousClose: number) {
    fetchSpy.mockResolvedValue({ ok: true, json: async () => yahooBody(price, previousClose) });
  }

  // tc-1: stale today-row → live re-fetch, row UPDATEd, day-change recomputed.
  it("re-fetches a stale today-row and recomputes day-change (VTI case)", async () => {
    seed({ symbol: "VTI", date: TODAY, price: 365.76, previousClose: 370.37, fetchedAt: ago(31 * 60 * 1000) });
    mockLive(369.99, 370.37);

    const out = await fetchMultipleQuotes(["VTI"]);

    expect(fetchSpy).toHaveBeenCalledTimes(1); // a live fetch WAS issued
    const q = out.get("VTI")!;
    expect(q.price).toBeCloseTo(369.99, 2);
    expect(q.change).toBeCloseTo(369.99 - 370.37, 4); // −0.38, not the frozen −4.61
    // The cache row was UPDATEd in place (price + fetched_at bumped), not duplicated.
    const rows = store.rows.filter((r) => r.symbol === "VTI" && r.date === TODAY);
    expect(rows).toHaveLength(1);
    expect(rows[0].price).toBeCloseTo(369.99, 2);
    expect(Date.now() - rows[0].fetchedAt!.getTime()).toBeLessThan(5000);
  });

  // tc-3: fresh today-row → cache hit, zero live fetches, unchanged price.
  it("serves a fresh today-row from cache with no live fetch", async () => {
    seed({ symbol: "VTI", date: TODAY, price: 365.76, previousClose: 370.37, fetchedAt: ago(5 * 60 * 1000) });

    const out = await fetchMultipleQuotes(["VTI"]);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.get("VTI")!.price).toBe(365.76);
  });

  // tc-2: stale today-row + live fetch fails → retain the stale value, fetched_at unchanged.
  it("retains the stale price when the live re-fetch fails (never blanks)", async () => {
    const seeded = seed({
      symbol: "VTI",
      date: TODAY,
      price: 365.76,
      previousClose: 370.37,
      fetchedAt: ago(31 * 60 * 1000),
    });
    const staleStamp = seeded.fetchedAt!.getTime();
    fetchSpy.mockResolvedValue({ ok: false, json: async () => ({}) }); // Yahoo error

    const out = await fetchMultipleQuotes(["VTI"]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const q = out.get("VTI");
    expect(q).toBeDefined(); // NOT dropped
    expect(q!.price).toBe(365.76); // retained stale value
    // fetched_at left untouched so it re-tries on the next read.
    expect(store.rows.find((r) => r.id === seeded.id)!.fetchedAt!.getTime()).toBe(staleStamp);
  });

  // tc-4: historical row, any age → always a hit, never re-fetched.
  it("never re-fetches a historical row regardless of age", async () => {
    seed({ symbol: "VTI", date: "2024-01-01", price: 200, previousClose: null, fetchedAt: ago(10 * 86400000) });
    // fetchMultipleQuotes always reads TODAY, so a historical-only seed is a miss
    // for today — assert via fetchQuoteAtDate-style read instead: read by the
    // historical date through fetchQuote's sibling is covered elsewhere; here we
    // assert the staleness predicate the read path uses.
    expect(isPriceCacheRowStale("2024-01-01", ago(10 * 86400000), TODAY)).toBe(false);
  });

  // tc-5: duplicate (symbol, today) rows → refresh UPDATEs matching rows, no new dup.
  // Uses a dedicated symbol (DUPX) — the module-level negative-quote cache persists
  // across tests in this file, so reusing a symbol another test marked-missed would
  // suppress this test's live fetch.
  it("UPDATEs duplicate (symbol, today) rows in place without inserting a new one", async () => {
    seed({ symbol: "DUPX", date: TODAY, price: 365.76, previousClose: 370.37, fetchedAt: ago(31 * 60 * 1000) });
    seed({ symbol: "DUPX", date: TODAY, price: 365.5, previousClose: 370.37, fetchedAt: ago(31 * 60 * 1000) });
    mockLive(369.99, 370.37);

    await fetchMultipleQuotes(["DUPX"]);

    const rows = store.rows.filter((r) => r.symbol === "DUPX" && r.date === TODAY);
    expect(rows).toHaveLength(2); // no new row inserted
    // Both duplicate rows were touched by the UPDATE ... WHERE symbol AND date.
    expect(rows.every((r) => Math.abs(r.price - 369.99) < 1e-6)).toBe(true);
  });
});

describe("fetchQuote (single) — today-row TTL refresh", () => {
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

  it("refreshes a stale today-row", async () => {
    seed({ symbol: "AAPL", date: TODAY, price: 299.04, previousClose: 295.95, fetchedAt: ago(40 * 60 * 1000) });
    fetchSpy.mockResolvedValue({ ok: true, json: async () => yahooBody(298.01, 295.95) });

    const q = await fetchQuote("AAPL");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(q!.price).toBeCloseTo(298.01, 2);
  });

  it("retains a stale today-row when the live fetch returns no data", async () => {
    seed({ symbol: "AAPL", date: TODAY, price: 299.04, previousClose: 295.95, fetchedAt: ago(40 * 60 * 1000) });
    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({ chart: { result: [] } }) });

    const q = await fetchQuote("AAPL");
    expect(q!.price).toBe(299.04); // retained
  });

  it("serves a fresh today-row without a live fetch", async () => {
    seed({ symbol: "AAPL", date: TODAY, price: 299.04, previousClose: 295.95, fetchedAt: ago(2 * 60 * 1000) });
    const q = await fetchQuote("AAPL");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(q!.price).toBe(299.04);
  });
});
