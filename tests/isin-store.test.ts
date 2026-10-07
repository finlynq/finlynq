/**
 * GH #365 — a security remembers the ISIN it was entered by, and an ISIN the
 * user has used before resolves from their own securities before Yahoo.
 * Real encryption (a throwaway DEK); the DB is a minimal in-memory fake.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import path from "path";

type Row = { id: number; userId: string; symbolCt: string | null; isinCt: string | null; isinLookup: string | null };
const rows: Row[] = [];
let lastUpdate: Record<string, unknown> | null = null;

vi.mock("@/db", async () => {
  const { schema } = await vi.importActual<typeof import("@/db")>("@/db").catch(() => ({ schema: {} as never }));
  return {
    schema,
    db: {
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            lastUpdate = values;
            const r = rows[0];
            if (r) Object.assign(r, { isinCt: values.isinCt, isinLookup: values.isinLookup });
          },
        }),
      }),
      select: () => ({
        from: () => ({
          // The fake ignores the WHERE and matches on the lookup the caller computed.
          where: () => ({ get: async () => rows.find((r) => r.isinLookup === wantedLookup) ?? undefined }),
        }),
      }),
    },
  };
});

let wantedLookup: string | null = null;
const marketFetch = vi.fn();
vi.mock("@/lib/market-fetch", () => ({ marketFetch: (...a: unknown[]) => marketFetch(...a) }));

import { buildNameFields, nameLookup } from "@/lib/crypto/encrypted-columns";
import { findSymbolByIsin, rememberSecurityIsin, resolveIsinForUser } from "@/lib/securities/isin-store";
import { resolveIsinTickersInPlace } from "@/lib/securities/isin-resolve";

const dek = randomBytes(32);

beforeEach(() => {
  rows.length = 0;
  lastUpdate = null;
  wantedLookup = null;
  marketFetch.mockReset();
  (globalThis as { __pfIsinCache?: Map<string, unknown> }).__pfIsinCache?.clear();
});

describe("rememberSecurityIsin", () => {
  it("stores the ISIN encrypted, with the same HMAC lookup the symbol uses", async () => {
    rows.push({ id: 1, userId: "u", symbolCt: null, isinCt: null, isinLookup: null });
    await rememberSecurityIsin("u", dek, 1, " inf209k01yn0 ");
    expect(lastUpdate?.isinCt).toMatch(/^v1:/);
    expect(lastUpdate?.isinLookup).toBe(nameLookup(dek, "INF209K01YN0"));
    expect(JSON.stringify(lastUpdate)).not.toContain("INF209K01YN0");
  });

  it("does nothing without a DEK, a security, or a valid ISIN", async () => {
    await rememberSecurityIsin("u", null, 1, "INF209K01YN0");
    await rememberSecurityIsin("u", dek, null, "INF209K01YN0");
    await rememberSecurityIsin("u", dek, 1, "NOT-AN-ISIN");
    expect(lastUpdate).toBeNull();
  });
});

describe("findSymbolByIsin / resolveIsinForUser", () => {
  beforeEach(() => {
    const enc = buildNameFields(dek, { symbol: "0P0000XVYH.BO", isin: "INF209K01YN0" });
    rows.push({
      id: 1,
      userId: "u",
      symbolCt: enc.symbolCt,
      isinCt: enc.isinCt,
      isinLookup: enc.isinLookup,
    });
    wantedLookup = nameLookup(dek, "INF209K01YN0");
  });

  it("finds the user's stored ticker for an ISIN they've used before", async () => {
    expect(await findSymbolByIsin("u", dek, "inf209k01yn0")).toBe("0P0000XVYH.BO");
  });

  it("answers from stored securities without asking Yahoo", async () => {
    expect(await resolveIsinForUser("u", dek, "INF209K01YN0")).toEqual({ symbol: "0P0000XVYH.BO", source: "stored" });
    expect(marketFetch).not.toHaveBeenCalled();
  });

  it("falls back to Yahoo for an ISIN the user hasn't stored", async () => {
    wantedLookup = "nothing-matches";
    marketFetch.mockResolvedValue({ ok: true, json: async () => ({ quotes: [{ symbol: "RELIANCE.NS", quoteType: "EQUITY" }] }) });
    const r = await resolveIsinForUser("u", dek, "INE002A01018");
    expect(r?.symbol).toBe("RELIANCE.NS");
    expect(r?.source).toBe("yahoo");
  });

  it("finds nothing without a DEK (the HMAC lookup needs it)", async () => {
    expect(await findSymbolByIsin("u", null, "INF209K01YN0")).toBeNull();
  });
});

describe("imports use the user-aware lookup", () => {
  it("resolveIsinTickersInPlace takes the lookup it's given", async () => {
    const lookup = vi.fn(async (isin: string) => (isin === "INF209K01YN0" ? { symbol: "0P0000XVYH.BO" } : null));
    const r = [{ ticker: "INF209K01YN0" }, { ticker: "US0378331005" }];
    expect(await resolveIsinTickersInPlace(r, lookup)).toBe(1);
    expect(r.map((x) => x.ticker)).toEqual(["0P0000XVYH.BO", "US0378331005"]);
    expect(marketFetch).not.toHaveBeenCalled();
  });

  it("staging passes resolveIsinForUser, and every write path remembers the ISIN", () => {
    const read = (rel: string) => readFileSync(path.resolve(__dirname, "..", rel), "utf8");
    expect(read("src/lib/import/stage-statement-file.ts")).toMatch(
      /resolveIsinTickersInPlace\(shaped, \(isin\) => resolveIsinForUser\(userId, dek, isin\)\)/,
    );
    const portfolio = read("src/app/api/portfolio/route.ts");
    expect(portfolio.match(/await rememberSecurityIsin\(/g)?.length ?? 0).toBe(2); // POST + PUT
    expect(portfolio).toMatch(/delete \(dataNoNames as Record<string, unknown>\)\.isin;/);
    expect(read("src/app/api/securities/define/route.ts")).toMatch(/await rememberSecurityIsin\(userId, dek, securityId, body\.isin\)/);
    expect(read("mcp-server/tools/portfolio.ts").match(/await rememberSecurityIsin\(/g)?.length ?? 0).toBe(2);
    expect(read("src/app/api/portfolio/symbol-info/route.ts")).toMatch(/resolveIsinForUser\(/);
    expect(read("src/app/api/securities/lookup/route.ts")).toMatch(/resolveIsinForUser\(/);
    expect(read("src/app/api/securities/route.ts")).toMatch(/isinCt: "isin"/);
  });
});
