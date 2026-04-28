import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDbChain: Record<string, ReturnType<typeof vi.fn>> = {};
const chainMethods = ["select", "from", "where", "orderBy", "leftJoin", "insert", "delete", "values", "returning"];
for (const m of chainMethods) {
  mockDbChain[m] = vi.fn().mockReturnValue(mockDbChain);
}
mockDbChain.all = vi.fn().mockReturnValue([]);
mockDbChain.get = vi.fn().mockReturnValue(undefined);
mockDbChain.run = vi.fn();

vi.mock("@/db", () => ({
  db: new Proxy({}, {
    get: (_t, prop) => mockDbChain[prop as string] ?? vi.fn().mockReturnValue(mockDbChain),
  }),
  schema: {
    targetAllocations: { id: "id", name: "name", targetPct: "targetPct", category: "category" },
    portfolioHoldings: { id: "id", name: "name", symbol: "symbol", currency: "currency", accountId: "accountId" },
    accounts: { id: "id", name: "name" },
    priceCache: { symbol: "symbol", date: "date", price: "price" },
  },
}));

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "default", method: "passphrase" as const, mfaVerified: false } })),
}));
vi.mock("drizzle-orm", () => ({ eq: vi.fn() }));

import { GET, POST } from "@/app/api/rebalancing/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

describe("API /api/rebalancing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const m of chainMethods) mockDbChain[m]!.mockReturnValue(mockDbChain);
    mockDbChain.all!.mockReturnValue([]);
    mockDbChain.get!.mockReturnValue(undefined);
  });

  describe("GET", () => {
    it("returns rebalancing data", async () => {
      const req = createMockRequest("http://localhost:3000/api/rebalancing");
      const res = await GET(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      const d = data as Record<string, unknown>;
      expect(d).toHaveProperty("targets");
      expect(d).toHaveProperty("comparison");
      expect(d).toHaveProperty("totalValue");
      expect(d).toHaveProperty("needsRebalancing");
    });

    it("returns empty comparison when no targets", async () => {
      const req = createMockRequest("http://localhost:3000/api/rebalancing");
      const res = await GET(req);
      const { data } = await parseResponse(res);
      const d = data as { comparison: unknown[]; targets: unknown[] };
      expect(d.targets).toEqual([]);
      expect(d.comparison).toEqual([]);
    });
  });

  describe("POST", () => {
    it("sets target allocations", async () => {
      const req = createMockRequest("http://localhost:3000/api/rebalancing", {
        method: "POST",
        body: {
          action: "set-targets",
          targets: [
            { name: "US Equity", targetPct: 50, category: "US" },
            { name: "Canadian", targetPct: 30, category: "Canada" },
          ],
        },
      });
      const res = await POST(req);
      const { data } = await parseResponse(res);
      expect(data).toEqual({ success: true });
    });

    it("creates single allocation target", async () => {
      const target = { id: 1, name: "Bonds", targetPct: 20, category: "Bonds" };
      mockDbChain.get!.mockReturnValueOnce(target);
      const req = createMockRequest("http://localhost:3000/api/rebalancing", {
        method: "POST",
        body: { name: "Bonds", targetPct: 20, category: "Bonds" },
      });
      const res = await POST(req);
      const { status } = await parseResponse(res);
      expect(status).toBe(201);
    });
  });
});
