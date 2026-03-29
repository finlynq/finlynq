import { describe, it, expect, vi, beforeEach } from "vitest";

const mockIsUnlocked = vi.fn();
const mockGetDialect = vi.fn();
vi.mock("@/db", () => ({
  isUnlocked: () => mockIsUnlocked(),
  getDialect: () => mockGetDialect(),
}));

import { requireUnlock } from "@/lib/require-unlock";

describe("requireUnlock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDialect.mockReturnValue("sqlite");
  });

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

  it("always returns null in managed (postgres) mode", () => {
    mockGetDialect.mockReturnValue("postgres");
    mockIsUnlocked.mockReturnValue(false);
    expect(requireUnlock()).toBeNull();
  });
});
