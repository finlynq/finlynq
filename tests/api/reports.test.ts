import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDbChain: Record<string, ReturnType<typeof vi.fn>> = {};
const chainMethods = ["select", "from", "where", "orderBy", "leftJoin", "groupBy"];
for (const m of chainMethods) {
  mockDbChain[m] = vi.fn().mockReturnValue(mockDbChain);
}
mockDbChain.all = vi.fn().mockReturnValue([]);
mockDbChain.get = vi.fn().mockReturnValue(undefined);

vi.mock("@/db", () => ({
  db: new Proxy({}, {
    get: (_t, prop) => mockDbChain[prop as string] ?? vi.fn().mockReturnValue(mockDbChain),
  }),
  schema: {
    transactions: { id: "id", date: "date", amount: "amount", accountId: "accountId", categoryId: "categoryId", currency: "currency", isBusiness: "isBusiness" },
    categories: { id: "id", type: "type", group: "group", name: "name" },
    accounts: { id: "id", type: "type", group: "group", name: "name", currency: "currency" },
  },
}));

vi.mock("@/lib/require-unlock", () => ({ requireUnlock: vi.fn(() => null) }));

vi.mock("@/lib/fx-service", () => ({
  getRateMap: vi.fn(async () => new Map([["CAD", 1]])),
  convertWithRateMap: vi.fn((amount: number) => amount),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(), and: vi.fn(), gte: vi.fn(), lte: vi.fn(), sql: vi.fn(),
}));

import { GET } from "@/app/api/reports/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

describe("API /api/reports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const m of chainMethods) mockDbChain[m]!.mockReturnValue(mockDbChain);
    mockDbChain.all!.mockReturnValue([]);
  });

  it("returns income statement by default", async () => {
    const req = createMockRequest("http://localhost:3000/api/reports");
    const res = await GET(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    const d = data as Record<string, unknown>;
    expect(d.type).toBe("income-statement");
    expect(d).toHaveProperty("income");
    expect(d).toHaveProperty("expenses");
    expect(d).toHaveProperty("totalIncome");
    expect(d).toHaveProperty("totalExpenses");
    expect(d).toHaveProperty("netSavings");
    expect(d).toHaveProperty("savingsRate");
  });

  it("returns balance sheet", async () => {
    const req = createMockRequest("http://localhost:3000/api/reports?type=balance-sheet");
    const res = await GET(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    const d = data as Record<string, unknown>;
    expect(d.type).toBe("balance-sheet");
    expect(d).toHaveProperty("assets");
    expect(d).toHaveProperty("liabilities");
    expect(d).toHaveProperty("netWorth");
  });

  it("returns tax summary", async () => {
    const req = createMockRequest("http://localhost:3000/api/reports?type=tax-summary");
    const res = await GET(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    const d = data as Record<string, unknown>;
    expect(d.type).toBe("tax-summary");
    expect(d).toHaveProperty("items");
  });

  it("returns 400 for invalid report type", async () => {
    const req = createMockRequest("http://localhost:3000/api/reports?type=invalid");
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("accepts custom date range", async () => {
    const req = createMockRequest("http://localhost:3000/api/reports?startDate=2023-01-01&endDate=2023-12-31");
    const res = await GET(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect((data as { period: { startDate: string } }).period.startDate).toBe("2023-01-01");
  });

  it("accepts business filter", async () => {
    const req = createMockRequest("http://localhost:3000/api/reports?business=true");
    const res = await GET(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(200);
  });

  it("accepts custom display currency", async () => {
    const req = createMockRequest("http://localhost:3000/api/reports?currency=USD");
    const res = await GET(req);
    const { data } = await parseResponse(res);
    expect((data as { displayCurrency: string }).displayCurrency).toBe("USD");
  });
});
