/**
 * FINLYNQ-176 tc-5 — read-only lot inspector route data.
 *
 * GET /api/portfolio/holdings/[holdingId]/lots returns lots[] + closures[]
 * for a holding, and each returned closure.realizedGain equals the stored
 * holding_lot_closures row value.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const dbHolder = vi.hoisted(() => ({ results: [] as unknown[][] }));

vi.mock("@/db", () => {
  function makeChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    const passthrough = ["select", "from", "where", "orderBy", "limit"];
    for (const m of passthrough) chain[m] = vi.fn(() => chain);
    const resolve = () => (dbHolder.results.length ? dbHolder.results.shift()! : []);
    chain.then = (r: (v: unknown) => unknown) => r(resolve());
    return chain;
  }
  const db = makeChain();
  return {
    db,
    schema: {
      holdingLots: {
        id: {}, userId: {}, holdingId: {}, accountId: {}, openTxId: {},
        openDate: {}, qtyOriginal: {}, qtyRemaining: {}, costPerShare: {},
        currency: {}, origin: {}, status: {}, side: {},
      },
      holdingLotClosures: {
        id: {}, userId: {}, lotId: {}, closeTxId: {}, closeDate: {},
        qtyClosed: {}, proceedsPerShare: {}, costPerShare: {},
        realizedGain: {}, currency: {}, closeKind: {},
      },
    },
  };
});

const authHolder = vi.hoisted(() => ({ ctx: { userId: "u" } as unknown }));
vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: authHolder.ctx })),
}));
vi.mock("@/lib/validate", () => ({
  logApiError: vi.fn(async () => undefined),
  safeErrorMessage: (_e: unknown, fallback: string) => fallback,
}));

import { GET } from "@/app/api/portfolio/holdings/[holdingId]/lots/route";

beforeEach(() => {
  dbHolder.results = [];
});

describe("GET /api/portfolio/holdings/[holdingId]/lots", () => {
  it("returns lots + closures with realizedGain matching the stored row", async () => {
    const lotRows = [
      {
        id: 1, userId: "u", holdingId: 200, accountId: 100, openTxId: 5,
        openDate: "2024-01-15", qtyOriginal: 10, qtyRemaining: 0,
        costPerShare: 100, currency: "USD", origin: "buy", status: "closed",
        side: "long",
      },
    ];
    const closureRows = [
      {
        id: 7, userId: "u", lotId: 1, closeTxId: 99, closeDate: "2025-06-01",
        qtyClosed: 10, proceedsPerShare: 150, costPerShare: 100,
        realizedGain: 500, currency: "USD", closeKind: "sell",
      },
    ];
    // Route reads lots first, then closures.
    dbHolder.results = [lotRows, closureRows];

    const req = {
      nextUrl: { searchParams: new URLSearchParams() },
    } as unknown as import("next/server").NextRequest;
    const res = await GET(req, { params: Promise.resolve({ holdingId: "200" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lots).toHaveLength(1);
    expect(body.lots[0].id).toBe(1);
    expect(body.lots[0].side).toBe("long");
    expect(body.closures).toHaveLength(1);
    expect(body.closures[0].closeTxId).toBe(99);
    expect(body.closures[0].realizedGain).toBe(500); // matches stored row
  });

  it("400s on a non-positive holdingId", async () => {
    const req = {
      nextUrl: { searchParams: new URLSearchParams() },
    } as unknown as import("next/server").NextRequest;
    const res = await GET(req, { params: Promise.resolve({ holdingId: "0" }) });
    expect(res.status).toBe(400);
  });
});
