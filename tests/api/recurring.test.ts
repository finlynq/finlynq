import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDbChain: Record<string, ReturnType<typeof vi.fn>> = {};
const chainMethods = ["select", "from", "leftJoin", "where", "orderBy"];
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
    transactions: { id: "id", date: "date", payee: "payee", amount: "amount", accountId: "accountId", categoryId: "categoryId", userId: "userId" },
    categories: { id: "id", type: "type" },
  },
}));

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "default", method: "passphrase" as const, mfaVerified: false, dek: Buffer.alloc(32, 0xaa), sessionId: "test-session-jti" } })),
}));

vi.mock("@/lib/fx-service", () => ({
  getDisplayCurrency: vi.fn(async (_userId: string, override?: string | null) => override ?? "USD"),
  getRateMap: vi.fn(async () => new Map()),
  convertWithRateMap: vi.fn((amount: number) => amount),
}));

// GH #428 — the dismissal store reads its own table; no dismissals here.
vi.mock("@/lib/subscriptions/dismissals", () => ({
  dismissedLookups: vi.fn(async () => new Set<string>()),
  withoutDismissed: <T,>(rows: T[]) => rows,
}));
vi.mock("@/lib/recurring-detector", () => ({
  detectRecurringTransactions: vi.fn(() => [
    { payee: "Netflix", avgAmount: -15.99, currency: "USD", frequency: "monthly", count: 6, lastDate: "2024-01-01", nextDate: "2024-02-01", accountId: 1, categoryId: 2 },
    { payee: "Employer", avgAmount: 5000, currency: "USD", frequency: "biweekly", count: 12, lastDate: "2024-01-15", nextDate: "2024-01-29", accountId: 1, categoryId: 3 },
  ]),
  forecastCashFlow: vi.fn(() => []),
}));

vi.mock("drizzle-orm", () => ({ sql: vi.fn(), and: vi.fn(), eq: vi.fn() }));

import { GET } from "@/app/api/recurring/route";
import { detectRecurringTransactions } from "@/lib/recurring-detector";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

describe("API /api/recurring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const m of chainMethods) mockDbChain[m]!.mockReturnValue(mockDbChain);
    mockDbChain.all!.mockReturnValue([]);
  });

  it("returns recurring transactions", async () => {
    const req = createMockRequest("http://localhost:3000/api/recurring");
    const res = await GET(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    const d = data as { recurring: unknown[]; monthlyRecurringTotal: number; count: number };
    expect(d).toHaveProperty("recurring");
    expect(d).toHaveProperty("monthlyRecurringTotal");
    expect(d).toHaveProperty("count");
    expect(d.count).toBe(2);
  });

  it("calculates monthly recurring total from expenses only", async () => {
    const req = createMockRequest("http://localhost:3000/api/recurring");
    const res = await GET(req);
    const { data } = await parseResponse(res);
    const d = data as { monthlyRecurringTotal: number };
    // Only Netflix (-15.99 monthly) should count
    expect(d.monthlyRecurringTotal).toBe(15.99);
  });

  it("asks the detector to drop lapsed series as of today", async () => {
    await GET(createMockRequest("http://localhost:3000/api/recurring"));
    const opts = vi.mocked(detectRecurringTransactions).mock.calls[0][1];
    expect(opts?.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
