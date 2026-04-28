import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "default", method: "passphrase" as const, mfaVerified: false } })),
}));

const mockGenerateWeeklyRecap = vi.fn();
vi.mock("@/lib/weekly-recap", () => ({
  generateWeeklyRecap: (...a: unknown[]) => mockGenerateWeeklyRecap(...a),
}));

import { GET } from "@/app/api/recap/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

describe("API /api/recap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateWeeklyRecap.mockReturnValue({
      weekOf: "2024-01-08",
      totalSpent: 500,
      totalIncome: 5000,
      topCategories: [],
    });
  });

  it("returns weekly recap", async () => {
    const req = createMockRequest("http://localhost:3000/api/recap");
    const res = await GET(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data).toHaveProperty("weekOf");
    expect(data).toHaveProperty("totalSpent");
  });

  it("passes date parameter", async () => {
    const req = createMockRequest("http://localhost:3000/api/recap?date=2024-01-15");
    await GET(req);
    expect(mockGenerateWeeklyRecap).toHaveBeenCalledWith("default", "2024-01-15");
  });

  it("uses undefined for missing date", async () => {
    const req = createMockRequest("http://localhost:3000/api/recap");
    await GET(req);
    expect(mockGenerateWeeklyRecap).toHaveBeenCalledWith("default", undefined);
  });
});
