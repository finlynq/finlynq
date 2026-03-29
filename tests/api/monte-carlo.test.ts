import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/require-unlock", () => ({
  requireUnlock: vi.fn(() => null),
}));

const mockRunSimulation = vi.fn();
vi.mock("@/lib/monte-carlo", () => ({
  runMonteCarloSimulation: (...a: unknown[]) => mockRunSimulation(...a),
}));

import { POST } from "@/app/api/fire/monte-carlo/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

describe("API /api/fire/monte-carlo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunSimulation.mockReturnValue({
      successRate: 0.85,
      medianOutcome: 2000000,
      percentiles: { p10: 500000, p25: 1000000, p50: 2000000, p75: 3000000, p90: 4500000 },
    });
  });

  it("runs monte carlo simulation with valid data", async () => {
    const req = createMockRequest("http://localhost:3000/api/fire/monte-carlo", {
      method: "POST",
      body: {
        currentInvestments: 100000,
        monthlySavings: 2000,
        annualReturn: 7,
        annualExpenses: 40000,
      },
    });
    const res = await POST(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data).toHaveProperty("successRate");
    expect(mockRunSimulation).toHaveBeenCalledWith(
      expect.objectContaining({
        currentInvestments: 100000,
        monthlySavings: 2000,
        annualReturn: 7,
        annualVolatility: 15,
        inflation: 2,
        yearsToSimulate: 30,
        numSimulations: 1000,
        withdrawalRate: 4,
        annualExpenses: 40000,
      })
    );
  });

  it("uses custom optional parameters", async () => {
    const req = createMockRequest("http://localhost:3000/api/fire/monte-carlo", {
      method: "POST",
      body: {
        currentInvestments: 200000,
        monthlySavings: 3000,
        annualReturn: 8,
        annualExpenses: 50000,
        annualVolatility: 20,
        inflation: 3,
        yearsToSimulate: 40,
        withdrawalRate: 3.5,
      },
    });
    await POST(req);
    expect(mockRunSimulation).toHaveBeenCalledWith(
      expect.objectContaining({
        annualVolatility: 20,
        inflation: 3,
        yearsToSimulate: 40,
        withdrawalRate: 3.5,
      })
    );
  });

  it("returns 400 for missing required fields", async () => {
    const req = createMockRequest("http://localhost:3000/api/fire/monte-carlo", {
      method: "POST",
      body: { currentInvestments: 100000 },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 500 when simulation throws", async () => {
    mockRunSimulation.mockImplementation(() => { throw new Error("Simulation error"); });
    const req = createMockRequest("http://localhost:3000/api/fire/monte-carlo", {
      method: "POST",
      body: {
        currentInvestments: 100000,
        monthlySavings: 2000,
        annualReturn: 7,
        annualExpenses: 40000,
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(500);
  });
});
