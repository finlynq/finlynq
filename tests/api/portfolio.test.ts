import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "default", method: "passphrase" as const, mfaVerified: false } })),
}));

const mockGetPortfolioHoldings = vi.fn();
vi.mock("@/lib/queries", () => ({
  getPortfolioHoldings: (...a: unknown[]) => mockGetPortfolioHoldings(...a),
}));

import { GET } from "@/app/api/portfolio/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

describe("API /api/portfolio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns portfolio holdings", async () => {
    const holdings = [
      { id: 1, accountId: 1, accountName: "TFSA", name: "VUN", symbol: "VUN.TO", currency: "CAD" },
    ];
    mockGetPortfolioHoldings.mockReturnValue(holdings);
    const req = createMockRequest("http://localhost:3000/api/portfolio");
    const res = await GET(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data).toEqual(holdings);
  });

  it("returns empty list when no holdings", async () => {
    mockGetPortfolioHoldings.mockReturnValue([]);
    const req = createMockRequest("http://localhost:3000/api/portfolio");
    const res = await GET(req);
    const { data } = await parseResponse(res);
    expect(data).toEqual([]);
  });
});
