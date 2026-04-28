import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "default", method: "passphrase" as const, mfaVerified: false } })),
}));

import { POST as completeOnboarding } from "@/app/api/onboarding/complete/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

describe("API /api/onboarding/complete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns success on completion", async () => {
    const req = createMockRequest("http://localhost:3000/api/onboarding/complete", { method: "POST" });
    const res = await completeOnboarding(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data).toEqual({ success: true });
  });
});
