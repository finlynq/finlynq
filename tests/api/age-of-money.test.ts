import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "default", method: "passphrase" as const, mfaVerified: false } })),
}));

const mockCalculateAgeOfMoney = vi.fn();
vi.mock("@/lib/age-of-money", () => ({
  calculateAgeOfMoney: (...a: unknown[]) => mockCalculateAgeOfMoney(...a),
}));

import { GET } from "@/app/api/age-of-money/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

describe("API /api/age-of-money", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns age of money data", async () => {
    mockCalculateAgeOfMoney.mockReturnValue({
      ageInDays: 25,
      trend: 3,
      history: [{ date: "2024-01-15", ageInDays: 25 }],
    });
    const req = createMockRequest("http://localhost:3000/api/age-of-money");
    const res = await GET(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    const d = data as { ageInDays: number; trend: number };
    expect(d.ageInDays).toBe(25);
    expect(d.trend).toBe(3);
  });

  it("handles zero age of money", async () => {
    mockCalculateAgeOfMoney.mockReturnValue({
      ageInDays: 0,
      trend: 0,
      history: [],
    });
    const req = createMockRequest("http://localhost:3000/api/age-of-money");
    const res = await GET(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect((data as { ageInDays: number }).ageInDays).toBe(0);
  });
});
