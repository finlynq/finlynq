import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDbChain: Record<string, ReturnType<typeof vi.fn>> = {};
const chainMethods = ["delete", "from", "where"];
for (const m of chainMethods) {
  mockDbChain[m] = vi.fn().mockReturnValue(mockDbChain);
}
mockDbChain.run = vi.fn();

vi.mock("@/db", () => ({
  db: new Proxy({}, {
    get: (_t, prop) => mockDbChain[prop as string] ?? vi.fn().mockReturnValue(mockDbChain),
  }),
  schema: {
    notifications: {}, subscriptions: {}, recurringTransactions: {},
    contributionRoom: {}, priceCache: {}, fxRates: {},
    targetAllocations: {}, snapshots: {}, goals: {}, loans: {},
    budgets: {}, transactions: {}, portfolioHoldings: {},
    categories: {}, accounts: {},
  },
}));

vi.mock("@/lib/require-unlock", () => ({ requireUnlock: vi.fn(() => null) }));

import { DELETE } from "@/app/api/data/route";
import { requireUnlock } from "@/lib/require-unlock";
import { parseResponse } from "../helpers/api-test-utils";
import { NextResponse } from "next/server";

describe("API /api/data", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const m of chainMethods) mockDbChain[m]!.mockReturnValue(mockDbChain);
  });

  it("clears all data", async () => {
    const res = await DELETE();
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data).toEqual({ success: true });
    // Should call delete for all tables
    expect(mockDbChain.run).toHaveBeenCalled();
  });

  it("returns 423 when locked", async () => {
    vi.mocked(requireUnlock).mockReturnValueOnce(
      NextResponse.json({ error: "Locked" }, { status: 423 })
    );
    const res = await DELETE();
    expect(res.status).toBe(423);
  });

  it("returns 500 on error", async () => {
    mockDbChain.run!.mockImplementation(() => { throw new Error("FK violation"); });
    const res = await DELETE();
    expect(res.status).toBe(500);
  });
});
