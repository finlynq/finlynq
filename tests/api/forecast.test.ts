import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDbChain: Record<string, ReturnType<typeof vi.fn>> = {};
const chainMethods = ["select", "from", "where", "orderBy", "leftJoin", "limit", "offset", "groupBy"];
for (const m of chainMethods) {
  mockDbChain[m] = vi.fn().mockReturnValue(mockDbChain);
}
mockDbChain.all = vi.fn().mockReturnValue([]);
mockDbChain.get = vi.fn().mockReturnValue({ total: 0 });

vi.mock("@/db", () => ({
  db: new Proxy({}, {
    get: (_t, prop) => mockDbChain[prop as string] ?? vi.fn().mockReturnValue(mockDbChain),
  }),
  schema: {
    transactions: { id: "id", date: "date", payee: "payee", amount: "amount", accountId: "accountId", categoryId: "categoryId" },
    accounts: { id: "id", group: "group" },
  },
}));

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "default", method: "passphrase" as const, mfaVerified: false } })),
}));

vi.mock("@/lib/recurring-detector", () => ({
  detectRecurringTransactions: vi.fn(() => []),
  forecastCashFlow: vi.fn(() => [
    { date: "2024-02-01", balance: 4500, income: 0, expense: 0 },
    { date: "2024-03-01", balance: 4000, income: 0, expense: 0 },
  ]),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(), sql: vi.fn(), and: vi.fn(), desc: vi.fn(),
}));

import { GET } from "@/app/api/forecast/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

describe("API /api/forecast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const m of chainMethods) mockDbChain[m]!.mockReturnValue(mockDbChain);
    mockDbChain.all!.mockReturnValue([]);
    mockDbChain.get!.mockReturnValue({ total: 5000 });
  });

  it("returns forecast data", async () => {
    const req = createMockRequest("http://localhost:3000/api/forecast");
    const res = await GET(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    const d = data as Record<string, unknown>;
    expect(d).toHaveProperty("currentBalance");
    expect(d).toHaveProperty("forecast");
    expect(d).toHaveProperty("warnings");
    expect(d).toHaveProperty("daysAhead");
  });

  it("defaults to 90 days forecast", async () => {
    const req = createMockRequest("http://localhost:3000/api/forecast");
    const res = await GET(req);
    const { data } = await parseResponse(res);
    expect((data as { daysAhead: number }).daysAhead).toBe(90);
  });

  it("accepts custom days parameter", async () => {
    const req = createMockRequest("http://localhost:3000/api/forecast?days=30");
    const res = await GET(req);
    const { data } = await parseResponse(res);
    expect((data as { daysAhead: number }).daysAhead).toBe(30);
  });
});
