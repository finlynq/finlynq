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

// Mock api-auth for API key strategy
vi.mock("@/lib/api-auth", () => ({
  validateApiKey: vi.fn(() => null), // valid by default
}));

// Mock JWT verification for account strategy and passphrase session cookie
vi.mock("@/lib/auth/jwt", () => ({
  verifySessionToken: vi.fn(async () => null),
  createSessionToken: vi.fn(async () => "mock-token"),
}));

import { requireAuth } from "@/lib/auth/require-auth";
import { verifySessionToken } from "@/lib/auth/jwt";
import { validateApiKey } from "@/lib/api-auth";

function makeRequest(
  headers: Record<string, string> = {},
  cookies: Record<string, string> = {}
): NextRequest {
  const url = "http://localhost:3000/api/test";
  const allHeaders = new Headers(headers);
  if (Object.keys(cookies).length > 0) {
    allHeaders.set(
      "cookie",
      Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ")
    );
  }
  return new NextRequest(url, { headers: allHeaders });
}

describe("requireAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDialect.mockReturnValue("sqlite");
    mockIsUnlocked.mockReturnValue(true);
  });

  describe("SQLite (self-hosted) mode", () => {
    it("uses passphrase strategy and succeeds when unlocked with valid session", async () => {
      vi.mocked(verifySessionToken).mockResolvedValue({
        sub: "default",
        email: "self-hosted",
        mfa: false,
        iss: "pf-auth",
        aud: "pf-app",
      });
      const result = await requireAuth(makeRequest({}, { pf_session: "valid-token" }));
      expect(result.authenticated).toBe(true);
      if (result.authenticated) {
        expect(result.context.method).toBe("passphrase");
        expect(result.context.userId).toBe("default");
      }
    });

    it("returns 423 when DB is locked", async () => {
      mockIsUnlocked.mockReturnValue(false);
      const result = await requireAuth(makeRequest());
      expect(result.authenticated).toBe(false);
      if (!result.authenticated) {
        expect(result.response.status).toBe(423);
      }
    });

    it("returns 401 when unlocked but no session cookie", async () => {
      const result = await requireAuth(makeRequest());
      expect(result.authenticated).toBe(false);
      if (!result.authenticated) {
        expect(result.response.status).toBe(401);
      }
    });
  });

  describe("PostgreSQL (managed) mode", () => {
    beforeEach(() => {
      mockGetDialect.mockReturnValue("postgres");
    });

    it("uses account strategy with valid Bearer token", async () => {
      vi.mocked(verifySessionToken).mockResolvedValue({
        sub: "user-abc",
        email: "test@test.com",
        mfa: true,
        iss: "pf-auth",
        aud: "pf-app",
      });

      const result = await requireAuth(
        makeRequest({ authorization: "Bearer valid-token" })
      );
      expect(result.authenticated).toBe(true);
      if (result.authenticated) {
        expect(result.context.method).toBe("account");
        expect(result.context.userId).toBe("user-abc");
        expect(result.context.mfaVerified).toBe(true);
      }
    });

    it("returns 401 without token", async () => {
      const result = await requireAuth(makeRequest());
      expect(result.authenticated).toBe(false);
      if (!result.authenticated) {
        expect(result.response.status).toBe(401);
      }
    });

    it("returns 401 with invalid token", async () => {
      vi.mocked(verifySessionToken).mockResolvedValue(null);
      const result = await requireAuth(
        makeRequest({ authorization: "Bearer bad-token" })
      );
      expect(result.authenticated).toBe(false);
      if (!result.authenticated) {
        expect(result.response.status).toBe(401);
      }
    });
  });

  describe("API key strategy", () => {
    it("uses API key strategy when X-API-Key header is present", async () => {
      vi.mocked(validateApiKey).mockReturnValue(null); // valid
      const result = await requireAuth(
        makeRequest({ "X-API-Key": "pf_test123" })
      );
      expect(result.authenticated).toBe(true);
      if (result.authenticated) {
        expect(result.context.method).toBe("api_key");
      }
    });

    it("returns 401 for invalid API key", async () => {
      vi.mocked(validateApiKey).mockReturnValue("Invalid API key");
      const result = await requireAuth(
        makeRequest({ "X-API-Key": "pf_bad" })
      );
      expect(result.authenticated).toBe(false);
      if (!result.authenticated) {
        expect(result.response.status).toBe(401);
      }
    });

    it("API key takes priority over dialect-based strategy", async () => {
      mockGetDialect.mockReturnValue("postgres");
      vi.mocked(validateApiKey).mockReturnValue(null);
      const result = await requireAuth(
        makeRequest({ "X-API-Key": "pf_test" })
      );
      expect(result.authenticated).toBe(true);
      if (result.authenticated) {
        expect(result.context.method).toBe("api_key");
      }
    });
  });
});
