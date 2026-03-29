import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "default", method: "passphrase" as const, mfaVerified: false } })),
}));

import { POST } from "@/app/api/fire/route";
import { requireAuth } from "@/lib/auth/require-auth";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";
import { NextResponse } from "next/server";

describe("API /api/fire", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const validBody = {
    currentAge: 30,
    targetRetirementAge: 55,
    currentInvestments: 100000,
    monthlySavings: 2000,
    annualReturn: 7,
    inflation: 2,
    annualExpenses: 40000,
    withdrawalRate: 4,
  };

  it("returns 401 when not authenticated", async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({
      authenticated: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });
    const req = createMockRequest("http://localhost:3000/api/fire", {
      method: "POST", body: validBody,
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("calculates FIRE number correctly", async () => {
    const req = createMockRequest("http://localhost:3000/api/fire", {
      method: "POST", body: validBody,
    });
    const res = await POST(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    const d = data as Record<string, unknown>;
    // FIRE number = annualExpenses / withdrawalRate = 40000 / 0.04 = 1,000,000
    expect(d.fireNumber).toBe(1000000);
    expect(d.yearsToFire).toBeGreaterThan(0);
    expect(d.fireAge).toBeGreaterThan(30);
    expect(d.projections).toBeDefined();
    expect(Array.isArray(d.projections)).toBe(true);
    expect(d.sensitivityTable).toBeDefined();
    expect(d.coastFireNumber).toBeGreaterThan(0);
  });

  it("includes projection data points", async () => {
    const req = createMockRequest("http://localhost:3000/api/fire", {
      method: "POST", body: validBody,
    });
    const res = await POST(req);
    const { data } = await parseResponse(res);
    const d = data as { projections: { age: number; year: number; netWorth: number }[] };
    expect(d.projections[0].age).toBe(30);
    expect(d.projections[0].year).toBe(0);
    expect(d.projections[0].netWorth).toBe(100000);
  });

  it("generates sensitivity table", async () => {
    const req = createMockRequest("http://localhost:3000/api/fire", {
      method: "POST", body: validBody,
    });
    const res = await POST(req);
    const { data } = await parseResponse(res);
    const d = data as { sensitivityTable: { returnRate: number; savings: number; yearsToFire: number }[] };
    // 5 return rates x 5 savings adjustments = 25 entries
    expect(d.sensitivityTable.length).toBe(25);
  });

  it("returns 400 for missing required fields", async () => {
    const req = createMockRequest("http://localhost:3000/api/fire", {
      method: "POST",
      body: { currentAge: 30 },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("handles edge case with zero withdrawal rate", async () => {
    const req = createMockRequest("http://localhost:3000/api/fire", {
      method: "POST",
      body: { ...validBody, withdrawalRate: 0 },
    });
    const res = await POST(req);
    // withdrawalRate 0 causes division by zero → Infinity fireNumber
    const { status } = await parseResponse(res);
    expect(status).toBe(200);
  });
});
