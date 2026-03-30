import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock db module
const mockIsUnlocked = vi.fn();
const mockGetDialect = vi.fn();
vi.mock("@/db", () => ({
  isUnlocked: () => mockIsUnlocked(),
  getDialect: () => mockGetDialect(),
  DEFAULT_USER_ID: "default",
}));

// Mock JWT verification for session cookie validation
const mockVerifySessionToken = vi.fn();
vi.mock("@/lib/auth/jwt", () => ({
  verifySessionToken: (...args: unknown[]) => mockVerifySessionToken(...args),
  createSessionToken: vi.fn(async () => "mock-token"),
}));

import { PassphraseStrategy } from "@/lib/auth/strategies/passphrase";

function makeRequest(cookies: Record<string, string> = {}): NextRequest {
  const url = "http://localhost:3000/api/test";
  const headers = new Headers();
  if (Object.keys(cookies).length > 0) {
    headers.set(
      "cookie",
      Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ")
    );
  }
  return new NextRequest(url, { headers });
}

describe("PassphraseStrategy", () => {
  const strategy = new PassphraseStrategy();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has method 'passphrase'", () => {
    expect(strategy.method).toBe("passphrase");
  });

  it("returns authenticated context when DB is unlocked and session cookie is valid", async () => {
    mockIsUnlocked.mockReturnValue(true);
    mockVerifySessionToken.mockResolvedValue({ sub: "default", email: "self-hosted", mfa: false });
    const result = await strategy.authenticate(makeRequest({ pf_session: "valid-token" }));
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
    const result = await strategy.authenticate(makeRequest());
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.response.status).toBe(423);
      const body = await result.response.json();
      expect(body.error).toContain("locked");
    }
  });

  it("returns 401 when DB is unlocked but no session cookie", async () => {
    mockIsUnlocked.mockReturnValue(true);
    const result = await strategy.authenticate(makeRequest());
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.response.status).toBe(401);
    }
  });

  it("returns 401 when DB is unlocked but session cookie is invalid", async () => {
    mockIsUnlocked.mockReturnValue(true);
    mockVerifySessionToken.mockResolvedValue(null);
    const result = await strategy.authenticate(makeRequest({ pf_session: "bad-token" }));
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.response.status).toBe(401);
    }
  });

  it("returns 401 when session cookie has wrong user ID", async () => {
    mockIsUnlocked.mockReturnValue(true);
    mockVerifySessionToken.mockResolvedValue({ sub: "wrong-user", email: "test", mfa: false });
    const result = await strategy.authenticate(makeRequest({ pf_session: "wrong-user-token" }));
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.response.status).toBe(401);
    }
  });
});
