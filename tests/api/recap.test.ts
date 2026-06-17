import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "default", method: "passphrase" as const, mfaVerified: false, dek: Buffer.alloc(32, 0xaa), sessionId: "test-session-jti" } })),
}));

const mockGenerateWeeklyRecap = vi.fn();
vi.mock("@/lib/weekly-recap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/weekly-recap")>();
  return {
    ...actual,
    generateWeeklyRecap: (...a: unknown[]) => mockGenerateWeeklyRecap(...a),
  };
});

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
    // The route also forwards the session DEK as a 3rd arg (null in this test —
    // no cached DEK) for payee decryption.
    expect(mockGenerateWeeklyRecap).toHaveBeenCalledWith("default", "2024-01-15", null);
  });

  it("uses undefined for missing date", async () => {
    const req = createMockRequest("http://localhost:3000/api/recap");
    await GET(req);
    expect(mockGenerateWeeklyRecap).toHaveBeenCalledWith("default", undefined, null);
  });
});

// ─── getWeekBounds unit tests (FINLYNQ-180) ────────────────────────────────
// Import the real function (not mocked) from the lib directly.
// NOTE: the mock above only covers the default export of the *route*'s
// generateWeeklyRecap. getWeekBounds is exported from the lib module itself
// and is never mocked here.
import { getWeekBounds } from "@/lib/weekly-recap";

describe("getWeekBounds", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // tc-1: no-arg path returns the last COMPLETED Sun→Sat week (FINLYNQ-180)
  it("tc-1 — no endDate: returns the last completed Sun→Sat week, never a future day (Tuesday clock)", () => {
    // Freeze clock at Tuesday 2026-06-16 local midnight.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-16T00:00:00"));

    const { weekStart, weekEnd, prevWeekStart, prevWeekEnd } = getWeekBounds();

    // Last completed week: Sun 2026-06-07 → Sat 2026-06-13
    expect(weekStart).toBe("2026-06-07");
    expect(weekEnd).toBe("2026-06-13");

    // Previous week: Sun 2026-05-31 → Sat 2026-06-06
    expect(prevWeekStart).toBe("2026-05-31");
    expect(prevWeekEnd).toBe("2026-06-06");

    // No future day is inside the reported window — weekEnd must be < today (2026-06-16).
    expect(weekEnd < "2026-06-16").toBe(true);
  });

  // tc-1 extra: verify the Sunday and Saturday edge-cases of the no-arg path.
  it("tc-1 — no endDate: correct last completed week on a Sunday clock", () => {
    vi.useFakeTimers();
    // Sunday 2026-06-14 — the week that JUST ended is Sun 06-07 → Sat 06-13.
    vi.setSystemTime(new Date("2026-06-14T00:00:00"));

    const { weekStart, weekEnd } = getWeekBounds();

    expect(weekStart).toBe("2026-06-07");
    expect(weekEnd).toBe("2026-06-13");
    // weekEnd must be before today (2026-06-14)
    expect(weekEnd < "2026-06-14").toBe(true);
  });

  it("tc-1 — no endDate: correct last completed week on a Saturday clock", () => {
    vi.useFakeTimers();
    // Saturday 2026-06-13 — the week that JUST ended is Sun 06-06? No:
    // dayOfWeek=6 → subtract 7 → 2026-06-06 (last Saturday), weekStart = 2026-05-31
    vi.setSystemTime(new Date("2026-06-13T00:00:00"));

    const { weekStart, weekEnd } = getWeekBounds();

    expect(weekStart).toBe("2026-05-31");
    expect(weekEnd).toBe("2026-06-06");
    expect(weekEnd < "2026-06-13").toBe(true);
  });

  // tc-2: explicit endDate must still return the week CONTAINING that date.
  it("tc-2 — explicit endDate='2026-06-16': returns the week containing that date (2026-06-14 → 2026-06-20)", () => {
    // No fake clock needed — explicit-date path is deterministic.
    const { weekStart, weekEnd, prevWeekStart, prevWeekEnd } = getWeekBounds("2026-06-16");

    // 2026-06-16 is a Tuesday; its Sun→Sat week is 06-14 → 06-20
    expect(weekStart).toBe("2026-06-14");
    expect(weekEnd).toBe("2026-06-20");

    // Previous week: 2026-06-07 → 2026-06-13
    expect(prevWeekStart).toBe("2026-06-07");
    expect(prevWeekEnd).toBe("2026-06-13");
  });

  it("tc-2 — explicit endDate='2026-06-13' (a Saturday): returns that same week", () => {
    const { weekStart, weekEnd } = getWeekBounds("2026-06-13");

    expect(weekStart).toBe("2026-06-07");
    expect(weekEnd).toBe("2026-06-13");
  });

  it("tc-2 — explicit endDate='2026-06-14' (a Sunday): returns that week (06-14 → 06-20)", () => {
    const { weekStart, weekEnd } = getWeekBounds("2026-06-14");

    expect(weekStart).toBe("2026-06-14");
    expect(weekEnd).toBe("2026-06-20");
  });
});
