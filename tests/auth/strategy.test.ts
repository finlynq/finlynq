import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock db module
const mockIsUnlocked = vi.fn();
const mockGetDialect = vi.fn();
vi.mock("@/db", () => ({
  isUnlocked: () => mockIsUnlocked(),
  getDialect: () => mockGetDialect(),
  DEFAULT_USER_ID: "default",
}));

import { PassphraseStrategy } from "@/lib/auth/strategies/passphrase";

describe("PassphraseStrategy", () => {
  const strategy = new PassphraseStrategy();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has method 'passphrase'", () => {
    expect(strategy.method).toBe("passphrase");
  });

  it("returns authenticated context when DB is unlocked", () => {
    mockIsUnlocked.mockReturnValue(true);
    const result = strategy.authenticate({} as never);
    expect(result).toEqual({
      authenticated: true,
      context: {
        userId: "default",
        method: "passphrase",
        mfaVerified: false,
      },
    });
  });

  it("returns 423 response when DB is locked", async () => {
    mockIsUnlocked.mockReturnValue(false);
    const result = strategy.authenticate({} as never);
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.response.status).toBe(423);
      const body = await result.response.json();
      expect(body.error).toContain("locked");
    }
  });
});
