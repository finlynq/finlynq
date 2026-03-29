import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDbChain: Record<string, ReturnType<typeof vi.fn>> = {};
const chainMethods = ["select", "from", "where", "orderBy", "leftJoin", "insert", "values", "returning"];
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
    contributionRoom: { id: "id", type: "type", year: "year", room: "room", used: "used", note: "note" },
    portfolioHoldings: { name: "name", symbol: "symbol", accountId: "accountId" },
    accounts: { id: "id", name: "name", type: "type" },
  },
}));

vi.mock("@/lib/require-unlock", () => ({ requireUnlock: vi.fn(() => null) }));

vi.mock("@/lib/tax-optimizer", () => ({
  getTotalTFSARoom: vi.fn(() => 95000),
  getRRSPRoom: vi.fn(() => 31560),
  getRESPGrant: vi.fn(() => 500),
  getAssetLocationAdvice: vi.fn(() => []),
  getMarginalRate: vi.fn((income: number) => income > 100000 ? 0.33 : 0.205),
  rrspVsTfsa: vi.fn(() => ({ rrspBetter: true, reason: "Higher income" })),
}));

vi.mock("drizzle-orm", () => ({ eq: vi.fn() }));

import { GET, POST } from "@/app/api/tax/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

describe("API /api/tax", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const m of chainMethods) mockDbChain[m]!.mockReturnValue(mockDbChain);
    mockDbChain.all!.mockReturnValue([]);
    mockDbChain.get!.mockReturnValue(undefined);
  });

  describe("GET", () => {
    it("returns tax data structure", async () => {
      const res = await GET();
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      const d = data as Record<string, unknown>;
      expect(d).toHaveProperty("tfsa");
      expect(d).toHaveProperty("rrsp");
      expect(d).toHaveProperty("resp");
      expect(d).toHaveProperty("assetLocationAdvice");
      expect(d).toHaveProperty("marginalRates");
    });

    it("includes TFSA room calculation", async () => {
      const res = await GET();
      const { data } = await parseResponse(res);
      const d = data as { tfsa: { totalRoom: number; remaining: number } };
      expect(d.tfsa.totalRoom).toBe(95000);
    });
  });

  describe("POST", () => {
    it("handles RRSP vs TFSA comparison", async () => {
      const req = createMockRequest("http://localhost:3000/api/tax", {
        method: "POST",
        body: { action: "rrsp-vs-tfsa", income: 80000, contribution: 5000 },
      });
      const res = await POST(req);
      const { status } = await parseResponse(res);
      expect(status).toBe(200);
    });

    it("creates contribution room record", async () => {
      const record = { id: 1, type: "TFSA", year: 2024, room: 7000, used: 3000 };
      mockDbChain.get!.mockReturnValueOnce(record);
      const req = createMockRequest("http://localhost:3000/api/tax", {
        method: "POST",
        body: { type: "TFSA", year: 2024, room: 7000, used: 3000 },
      });
      const res = await POST(req);
      const { status } = await parseResponse(res);
      expect(status).toBe(201);
    });
  });
});
