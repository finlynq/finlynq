import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/require-unlock", () => ({ requireUnlock: vi.fn(() => null) }));

import { POST as completeOnboarding } from "@/app/api/onboarding/complete/route";
import { parseResponse } from "../helpers/api-test-utils";

describe("API /api/onboarding/complete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns success on completion", async () => {
    const res = await completeOnboarding();
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data).toEqual({ success: true });
  });
});
