import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDbChain: Record<string, ReturnType<typeof vi.fn>> = {};
const chainMethods = ["select", "from", "where", "orderBy", "leftJoin", "groupBy"];
for (const m of chainMethods) {
  mockDbChain[m] = vi.fn().mockReturnValue(mockDbChain);
}
mockDbChain.all = vi.fn().mockReturnValue([]);

vi.mock("@/db", () => ({
  db: new Proxy({}, {
    get: (_t, prop) => mockDbChain[prop as string] ?? vi.fn().mockReturnValue(mockDbChain),
  }),
  schema: {
    transactions: { id: "id", date: "date", amount: "amount", categoryId: "categoryId", currency: "currency" },
    categories: { id: "id", type: "type", group: "group", name: "name" },
  },
}));

vi.mock("@/lib/require-unlock", () => ({ requireUnlock: vi.fn(() => null) }));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn(), and: vi.fn(), gte: vi.fn(), lte: vi.fn(), sql: vi.fn(),
}));

import { GET } from "@/app/api/reports/trends/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

describe("API /api/reports/trends", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const m of chainMethods) mockDbChain[m]!.mockReturnValue(mockDbChain);
    mockDbChain.all!.mockReturnValue([]);
  });

  it("returns trends data", async () => {
    const req = createMockRequest("http://localhost:3000/api/reports/trends");
    const res = await GET(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(200);
  });
});
