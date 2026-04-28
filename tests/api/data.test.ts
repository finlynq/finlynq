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
    contributionRoom: {}, priceCache: {}, fxRates: {}, fxOverrides: {},
    targetAllocations: {}, snapshots: {}, goals: {}, loans: {},
    budgets: {}, transactions: {}, portfolioHoldings: {},
    categories: {}, accounts: {},
  },
}));

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "default", method: "passphrase" as const, mfaVerified: false } })),
}));

import { DELETE } from "@/app/api/data/route";
import { requireAuth } from "@/lib/auth/require-auth";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";
import { NextResponse } from "next/server";

describe("API /api/data", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const m of chainMethods) mockDbChain[m]!.mockReturnValue(mockDbChain);
  });

  it("clears all data", async () => {
    const req = createMockRequest("http://localhost:3000/api/data", { method: "DELETE" });
    const res = await DELETE(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data).toEqual({ success: true });
    // Should call delete for all tables
    expect(mockDbChain.run).toHaveBeenCalled();
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({
      authenticated: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });
    const req = createMockRequest("http://localhost:3000/api/data", { method: "DELETE" });
    const res = await DELETE(req);
    expect(res.status).toBe(401);
  });

  it("returns 500 on error", async () => {
    mockDbChain.run!.mockImplementation(() => { throw new Error("FK violation"); });
    const req = createMockRequest("http://localhost:3000/api/data", { method: "DELETE" });
    const res = await DELETE(req);
    expect(res.status).toBe(500);
  });
});
