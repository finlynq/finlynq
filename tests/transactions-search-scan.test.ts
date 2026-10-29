/**
 * Whole-history search on the transactions list (in-app feedback #28,
 * 2026-10-29). GET /api/transactions matched `search` / `tag` / `filter_*`
 * over the newest 1,000 rows only, so a payee search missed every older
 * transaction and reported the matches inside that window as the total. The
 * route now finds matches across every row the SQL filters allow
 * (`findMatchingTransactionIds`) and fetches full rows for one page
 * (`getTransactionsByIds`).
 *
 * Three layers: the pure matching rules, the scan + page fetch against mocked
 * queries (real AES-GCM ciphertext), and a static gate on the route so the
 * capped window can't come back.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { encryptField } from "@/lib/crypto/envelope";

const mockSearchRows = vi.fn();
const mockGetTransactions = vi.fn();
vi.mock("@/lib/queries", () => ({
  getTransactionSearchRows: (...args: unknown[]) => mockSearchRows(...args),
  getTransactions: (...args: unknown[]) => mockGetTransactions(...args),
}));

// `db.select(...).from(...)[.leftJoin(...)].where(...)` resolves to whichever
// table the select names: accounts (no join) or holdings (join on securities).
const accountRows: Array<{ id: number; nameCt: string | null; aliasCt: string | null }> = [];
const holdingRows: Array<{ id: number; nameCt: string | null; securityNameCt: string | null }> = [];
vi.mock("@/db", async () => {
  const schemaPg = await vi.importActual<typeof import("@/db/schema-pg")>("@/db/schema-pg");
  return {
    schema: schemaPg,
    db: {
      select: () => ({
        from: () => ({
          where: async () => accountRows,
          leftJoin: () => ({ where: async () => holdingRows }),
        }),
      }),
    },
  };
});

import {
  filterTextRows,
  holdingDisplayName,
  type TextFilterRow,
} from "@/lib/transactions/search-match";
import {
  findMatchingTransactionIds,
  getTransactionsByIds,
  PAGE_CHUNK,
} from "@/lib/transactions/search-scan";

const DEK = Buffer.alloc(32, 0x5c);
const enc = (s: string | null) => encryptField(DEK, s);

function row(partial: Partial<TextFilterRow> & { id: number }): TextFilterRow {
  return {
    payee: null,
    note: null,
    tags: null,
    accountName: null,
    accountAlias: null,
    portfolioHolding: null,
    ...partial,
  };
}

describe("filterTextRows (matching rules)", () => {
  const rows = [
    row({ id: 1, payee: "Starbucks Coffee", tags: "food, travel" }),
    row({ id: 2, payee: "Grocer", note: "starbucks gift card" }),
    row({ id: 3, payee: "Rent", tags: "source:XY" }),
    row({ id: 4, payee: "Bank fee", accountName: "Chequing", accountAlias: "Main" }),
    row({ id: 5, payee: "Buy", portfolioHolding: "Vanguard Total Market" }),
  ];

  it("search matches payee, note or tags, case-insensitive", () => {
    expect(filterTextRows(rows, { search: "STARBUCKS" }).map((r) => r.id)).toEqual([1, 2]);
    expect(filterTextRows(rows, { search: "travel" }).map((r) => r.id)).toEqual([1]);
  });

  it("tag matches one whole tag, never a substring of one", () => {
    expect(filterTextRows(rows, { tag: "travel" }).map((r) => r.id)).toEqual([1]);
    expect(filterTextRows(rows, { tag: "source:X" })).toEqual([]);
  });

  it("per-column filters are substrings of their own field, ANDed together", () => {
    expect(filterTextRows(rows, { payee: "coffee" }).map((r) => r.id)).toEqual([1]);
    expect(filterTextRows(rows, { note: "GIFT" }).map((r) => r.id)).toEqual([2]);
    expect(filterTextRows(rows, { accountName: "cheq" }).map((r) => r.id)).toEqual([4]);
    expect(filterTextRows(rows, { accountAlias: "main" }).map((r) => r.id)).toEqual([4]);
    expect(filterTextRows(rows, { portfolio: "vanguard" }).map((r) => r.id)).toEqual([5]);
    expect(filterTextRows(rows, { tags: "food" }).map((r) => r.id)).toEqual([1]);
    expect(filterTextRows(rows, { search: "starbucks", payee: "grocer" }).map((r) => r.id)).toEqual([2]);
  });

  it("keeps the input order", () => {
    const reversed = [...rows].reverse();
    expect(filterTextRows(reversed, { search: "starbucks" }).map((r) => r.id)).toEqual([2, 1]);
  });
});

describe("holdingDisplayName", () => {
  it("prefers the security's name only when the read-flip is on", () => {
    expect(holdingDisplayName(enc("Cash USD"), enc("USD sleeve"), DEK, true)).toBe("Cash USD");
    expect(holdingDisplayName(enc("Cash USD"), enc("USD sleeve"), DEK, false)).toBe("USD sleeve");
  });

  it("falls back to the position's name, and to null without a DEK", () => {
    expect(holdingDisplayName(null, enc("USD sleeve"), DEK, true)).toBe("USD sleeve");
    expect(holdingDisplayName(enc("Cash USD"), enc("USD sleeve"), null, true)).toBeNull();
  });
});

describe("findMatchingTransactionIds (whole history)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accountRows.length = 0;
    holdingRows.length = 0;
  });

  it("finds matches far past the newest 1,000 rows, in list order", async () => {
    // 2,500 rows newest-first; the payee recurs every 100 rows, so 25 match
    // and 15 of them sit beyond the old 1,000-row window.
    const scan = Array.from({ length: 2500 }, (_, i) => ({
      id: 5000 - i,
      accountId: 1,
      portfolioHoldingId: null,
      payee: enc(i % 100 === 99 ? "Corner Bakery" : `Shop ${i}`),
      note: null,
      tags: null,
    }));
    mockSearchRows.mockResolvedValue(scan);

    const filters = { startDate: "2020-01-01", limit: 50, offset: 0 };
    const ids = await findMatchingTransactionIds("u1", DEK, filters, { search: "bakery" }, { securitiesRead: false });

    expect(ids).toHaveLength(25);
    expect(ids).toEqual(scan.filter((_, i) => i % 100 === 99).map((r) => r.id));
    expect(ids.filter((id) => id <= 5000 - 1000)).toHaveLength(15);
    // The scan gets the request's SQL filters as they are.
    expect(mockSearchRows).toHaveBeenCalledWith("u1", filters);
  });

  it("matches account and holding names from their own tables", async () => {
    accountRows.push(
      { id: 1, nameCt: enc("Everyday Chequing"), aliasCt: null },
      { id: 2, nameCt: enc("Brokerage"), aliasCt: enc("TFSA") },
    );
    holdingRows.push({ id: 9, nameCt: enc("old name"), securityNameCt: enc("Vanguard Total Market") });
    mockSearchRows.mockResolvedValue([
      { id: 3, accountId: 2, portfolioHoldingId: 9, payee: enc("Buy"), note: null, tags: null },
      { id: 2, accountId: 1, portfolioHoldingId: null, payee: enc("Coffee"), note: null, tags: null },
      { id: 1, accountId: 2, portfolioHoldingId: null, payee: enc("Deposit"), note: null, tags: null },
    ]);

    expect(await findMatchingTransactionIds("u1", DEK, {}, { accountName: "chequing" }, { securitiesRead: false }))
      .toEqual([2]);
    expect(await findMatchingTransactionIds("u1", DEK, {}, { accountAlias: "tfsa" }, { securitiesRead: false }))
      .toEqual([3, 1]);
    expect(await findMatchingTransactionIds("u1", DEK, {}, { portfolio: "vanguard" }, { securitiesRead: true }))
      .toEqual([3]);
    expect(await findMatchingTransactionIds("u1", DEK, {}, { portfolio: "vanguard" }, { securitiesRead: false }))
      .toEqual([]);
  });

  it("returns nothing without touching other queries when no row passes the SQL filters", async () => {
    mockSearchRows.mockResolvedValue([]);
    expect(await findMatchingTransactionIds("u1", DEK, {}, { accountName: "x" }, { securitiesRead: false }))
      .toEqual([]);
  });
});

describe("getTransactionsByIds (one page of full rows)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fetches in chunks with the ids filter and keeps the order", async () => {
    mockGetTransactions.mockImplementation(async (_u: string, f: { ids: number[] }) =>
      f.ids.map((id) => ({ id })),
    );
    const ids = Array.from({ length: PAGE_CHUNK * 2 + 5 }, (_, i) => 9000 - i);
    const filters = { sortColumnId: "amount" as const, sortDirection: "asc" as const, limit: 99999, offset: 40 };

    const rows = await getTransactionsByIds("u1", filters, ids);

    expect(rows.map((r) => r.id)).toEqual(ids);
    expect(mockGetTransactions).toHaveBeenCalledTimes(3);
    const first = mockGetTransactions.mock.calls[0][1];
    expect(first).toMatchObject({ sortColumnId: "amount", sortDirection: "asc", offset: 0, limit: PAGE_CHUNK });
    expect(first.ids).toEqual(ids.slice(0, PAGE_CHUNK));
    expect(mockGetTransactions.mock.calls[2][1]).toMatchObject({ limit: 5, ids: ids.slice(PAGE_CHUNK * 2) });
  });

  it("does not query for an empty page", async () => {
    expect(await getTransactionsByIds("u1", {}, [])).toEqual([]);
    expect(mockGetTransactions).not.toHaveBeenCalled();
  });
});

describe("GET /api/transactions wiring (static)", () => {
  const ROOT = path.resolve(__dirname, "..");
  const codeOnly = (rel: string) =>
    readFileSync(path.join(ROOT, rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it("routes text filters through the whole-history scan, with no capped window", () => {
    const route = codeOnly("src/app/api/transactions/route.ts");
    expect(route).toMatch(/findMatchingTransactionIds\(/);
    expect(route).toMatch(/getTransactionsByIds\(/);
    expect(route).not.toMatch(/postDecryptFilter\s*\?\s*1000/);
    expect(route).not.toMatch(/filterDecryptedBySearch/);
    expect(route).toMatch(/total\s*=\s*matchedIds\.length/);
  });

  it("the scan query reads every row (no LIMIT)", () => {
    const queries = codeOnly("src/lib/queries.ts");
    const start = queries.indexOf("export async function getTransactionSearchRows");
    const end = queries.indexOf("export async function getTransactionCount(", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(queries.slice(start, end)).not.toMatch(/\.limit\(|\.offset\(/);
  });
});
