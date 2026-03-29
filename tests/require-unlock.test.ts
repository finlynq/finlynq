import { describe, it, expect, vi } from "vitest";

const mockIsUnlocked = vi.fn();
vi.mock("@/db", () => ({
  isUnlocked: () => mockIsUnlocked(),
}));

import { requireUnlock } from "@/lib/require-unlock";

describe("requireUnlock", () => {
  it("returns null when database is unlocked", () => {
    mockIsUnlocked.mockReturnValue(true);
    expect(requireUnlock()).toBeNull();
  });

  it("returns 423 response when database is locked", async () => {
    mockIsUnlocked.mockReturnValue(false);
    const result = requireUnlock();
    expect(result).not.toBeNull();
    expect(result!.status).toBe(423);
    const body = await result!.json();
    expect(body.error).toContain("locked");
  });
});
