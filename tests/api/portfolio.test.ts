import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/require-unlock", () => ({ requireUnlock: vi.fn(() => null) }));

const mockGetPortfolioHoldings = vi.fn();
vi.mock("@/lib/queries", () => ({
  getPortfolioHoldings: (...a: unknown[]) => mockGetPortfolioHoldings(...a),
}));

import { GET } from "@/app/api/portfolio/route";
import { parseResponse } from "../helpers/api-test-utils";

describe("API /api/portfolio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns portfolio holdings", async () => {
    const holdings = [
      { id: 1, accountId: 1, accountName: "TFSA", name: "VUN", symbol: "VUN.TO", currency: "CAD" },
    ];
    mockGetPortfolioHoldings.mockReturnValue(holdings);
    const res = await GET();
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data).toEqual(holdings);
  });

  it("returns empty list when no holdings", async () => {
    mockGetPortfolioHoldings.mockReturnValue([]);
    const res = await GET();
    const { data } = await parseResponse(res);
    expect(data).toEqual([]);
  });
});
