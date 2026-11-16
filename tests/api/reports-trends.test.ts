import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDbChain: Record<string, ReturnType<typeof vi.fn>> = {};
const chainMethods = ["select", "from", "where", "orderBy", "leftJoin", "groupBy"];
for (const m of chainMethods) {
  mockDbChain[m] = vi.fn().mockReturnValue(mockDbChain);
}
mockDbChain.all = vi.fn().mockReturnValue([]);
// Make the chain awaitable — real Drizzle chains are thenables; without this,
// `await db.select()...` returns the chain object itself (not the rows),
// causing `rows.map`/`rows.length` to blow up in route code.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(mockDbChain as any).then = (resolve: (v: unknown) => unknown) => resolve([]);

vi.mock("@/db", () => ({
  db: new Proxy({}, {
    get: (_t, prop) => mockDbChain[prop as string] ?? vi.fn().mockReturnValue(mockDbChain),
  }),
  schema: {
    transactions: { id: "id", date: "date", amount: "amount", categoryId: "categoryId", currency: "currency", reportingCurrency: "reportingCurrency", reportingAmount: "reportingAmount", userId: "userId" },
    transactionCategoryFlows: { id: "id", date: "date", amount: "amount", categoryId: "categoryId", currency: "currency", reportingCurrency: "reportingCurrency", reportingAmount: "reportingAmount", userId: "userId", isBusiness: "isBusiness", accountId: "accountId" },
    categories: { id: "id", type: "type", group: "group", name: "name" },
  },
}));

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "default", method: "passphrase" as const, mfaVerified: false, dek: Buffer.alloc(32, 0xaa), sessionId: "test-session-jti" } })),
}));
// Phase 3 — the trends route now FX-converts (display currency + rate map) and
// fires a fire-and-forget reporting self-heal. Mock the fx-service so the route
// doesn't hit the real settings/rate lookups; selfHeal is best-effort (its mock
// db chain has no `.limit`, which it swallows) so no extra stub is needed.
vi.mock("@/lib/fx-service", () => ({
  getRateMap: vi.fn(async () => new Map([["CAD", 1]])),
  convertWithRateMap: vi.fn((amount: number) => amount),
  getDisplayCurrency: vi.fn(async (_userId: string, override: string | null) => override ?? "CAD"),
}));
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

  it("accepts the yearly period", async () => {
    const req = createMockRequest("http://localhost:3000/api/reports/trends?period=yearly");
    const res = await GET(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(200);
  });

  it("refuses an unknown period instead of guessing a granularity", async () => {
    const req = createMockRequest("http://localhost:3000/api/reports/trends?period=decade");
    const res = await GET(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(String((data as { error?: string }).error)).toContain("yearly");
  });
});
