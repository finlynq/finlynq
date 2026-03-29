import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/require-unlock", () => ({ requireUnlock: vi.fn(() => null) }));

const mockGetAccountBalances = vi.fn();
vi.mock("@/lib/queries", () => ({
  getAccountBalances: (...a: unknown[]) => mockGetAccountBalances(...a),
}));

const mockGetRateMap = vi.fn();
const mockGetActiveCurrencies = vi.fn();
const mockConvertWithRateMap = vi.fn();
vi.mock("@/lib/fx-service", () => ({
  getLatestFxRate: vi.fn(async () => 1.36),
  getActiveCurrencies: (...a: unknown[]) => mockGetActiveCurrencies(...a),
  getRateMap: (...a: unknown[]) => mockGetRateMap(...a),
  convertWithRateMap: (...a: unknown[]) => mockConvertWithRateMap(...a),
}));

import { GET } from "@/app/api/fx/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

describe("API /api/fx", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAccountBalances.mockReturnValue([]);
    mockGetActiveCurrencies.mockReturnValue(["CAD", "USD"]);
    mockGetRateMap.mockResolvedValue(new Map([["CAD", 1], ["USD", 1.36]]));
    mockConvertWithRateMap.mockImplementation((amount: number) => amount);
  });

  it("returns FX data structure", async () => {
    const req = createMockRequest("http://localhost:3000/api/fx");
    const res = await GET(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    const d = data as Record<string, unknown>;
    expect(d).toHaveProperty("rates");
    expect(d).toHaveProperty("activeCurrencies");
    expect(d).toHaveProperty("displayCurrency");
    expect(d).toHaveProperty("consolidated");
    expect(d).toHaveProperty("byAccount");
  });

  it("defaults to CAD target currency", async () => {
    const req = createMockRequest("http://localhost:3000/api/fx");
    const res = await GET(req);
    const { data } = await parseResponse(res);
    expect((data as { displayCurrency: string }).displayCurrency).toBe("CAD");
  });

  it("accepts custom target currency", async () => {
    const req = createMockRequest("http://localhost:3000/api/fx?target=USD");
    const res = await GET(req);
    const { data } = await parseResponse(res);
    expect((data as { displayCurrency: string }).displayCurrency).toBe("USD");
  });

  it("returns consolidated balance", async () => {
    mockGetAccountBalances.mockReturnValue([
      { accountId: 1, accountName: "Checking", currency: "CAD", balance: 5000 },
    ]);
    mockConvertWithRateMap.mockReturnValue(5000);
    const req = createMockRequest("http://localhost:3000/api/fx");
    const res = await GET(req);
    const { data } = await parseResponse(res);
    const d = data as { consolidated: { total: number } };
    expect(d.consolidated.total).toBe(5000);
  });
});
