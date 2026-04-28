import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "default", method: "passphrase" as const, mfaVerified: false } })),
}));

const mockGetSpotlightItems = vi.fn();
vi.mock("@/lib/spotlight", () => ({
  getSpotlightItems: (...a: unknown[]) => mockGetSpotlightItems(...a),
}));

import { GET } from "@/app/api/spotlight/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

describe("API /api/spotlight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSpotlightItems.mockReturnValue([
      { type: "achievement", title: "Savings Goal Met", description: "You saved $5000!" },
    ]);
  });

  it("returns spotlight items", async () => {
    const req = createMockRequest("http://localhost:3000/api/spotlight");
    const res = await GET(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    const d = data as { items: unknown[] };
    expect(d).toHaveProperty("items");
    expect(d.items.length).toBe(1);
  });

  it("returns empty items when none available", async () => {
    mockGetSpotlightItems.mockReturnValue([]);
    const req = createMockRequest("http://localhost:3000/api/spotlight");
    const res = await GET(req);
    const { data } = await parseResponse(res);
    const d = data as { items: unknown[] };
    expect(d.items).toEqual([]);
  });
});
