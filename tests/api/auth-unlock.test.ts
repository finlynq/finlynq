import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/db", () => ({
  initializeConnection: vi.fn(),
  isUnlocked: vi.fn(() => false),
  closeConnection: vi.fn(),
  getConnection: vi.fn(() => null),
  resetDb: vi.fn(),
  getDialect: vi.fn(() => "postgres"),
  DEFAULT_USER_ID: "default",
}));

vi.mock("@shared/crypto", () => ({
  generateSalt: vi.fn(() => Buffer.alloc(32)),
  deriveKey: vi.fn(() => "a".repeat(64)),
}));

vi.mock("@shared/config", () => ({
  readConfig: vi.fn(() => ({ mode: "postgres" })),
  writeConfig: vi.fn(),
  configExists: vi.fn(() => true),
  resolveDbPath: vi.fn(() => ""),
}));

vi.mock("@/db/migration", () => ({
  detectDbState: vi.fn(() => "ready"),
  migrateToEncrypted: vi.fn(),
}));

vi.mock("fs", () => ({
  default: { existsSync: vi.fn(() => true) },
  existsSync: vi.fn(() => true),
}));

const mockCheckRateLimit = vi.fn(() => ({ allowed: true, remaining: 4, resetAt: Date.now() + 60000 }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

// Mock JWT for session cookie issuance
vi.mock("@/lib/auth/jwt", () => ({
  createSessionToken: vi.fn(async () => "mock-session-token"),
  verifySessionToken: vi.fn(async () => null),
}));

import { GET, POST } from "@/app/api/auth/unlock/route";
import { isUnlocked, initializeConnection } from "@/db";
import { verifySessionToken } from "@/lib/auth/jwt";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

function makeGetRequest(cookies: Record<string, string> = {}): NextRequest {
  const url = "http://localhost:3000/api/auth/unlock";
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

describe("API /api/auth/unlock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockReturnValue({ allowed: true, remaining: 4, resetAt: Date.now() + 60000 });
  });

  describe("GET", () => {
    it("returns lock status and setup info", async () => {
      const res = await GET(makeGetRequest());
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      const d = data as { unlocked: boolean; needsSetup: boolean };
      expect(d).toHaveProperty("unlocked");
      expect(d).toHaveProperty("needsSetup");
    });

    it("reports unlocked when DB unlocked and valid session cookie", async () => {
      vi.mocked(isUnlocked).mockReturnValueOnce(true);
      vi.mocked(verifySessionToken).mockResolvedValueOnce({
        sub: "default",
        email: "self-hosted",
        mfa: false,
        iss: "pf-auth",
        aud: "pf-app",
      });
      const res = await GET(makeGetRequest({ pf_session: "valid-token" }));
      const { data } = await parseResponse(res);
      expect((data as { unlocked: boolean }).unlocked).toBe(true);
    });

    it("reports locked when DB unlocked but no session cookie", async () => {
      vi.mocked(isUnlocked).mockReturnValueOnce(true);
      const res = await GET(makeGetRequest());
      const { data } = await parseResponse(res);
      expect((data as { unlocked: boolean }).unlocked).toBe(false);
    });

    it("reports locked state when DB is locked", async () => {
      vi.mocked(isUnlocked).mockReturnValueOnce(false);
      const res = await GET(makeGetRequest());
      const { data } = await parseResponse(res);
      expect((data as { unlocked: boolean }).unlocked).toBe(false);
    });
  });

  describe("POST", () => {
    it("unlocks with valid passphrase and sets session cookie", async () => {
      const req = createMockRequest("http://localhost:3000/api/auth/unlock", {
        method: "POST",
        body: { action: "unlock", passphrase: "my-secure-passphrase" },
      });
      const res = await POST(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect(data).toEqual({ success: true });
      expect(initializeConnection).toHaveBeenCalled();
      // Verify session cookie was set
      const setCookie = res.headers.get("set-cookie");
      expect(setCookie).toContain("pf_session=");
    });

    it("locks the database and clears session cookie", async () => {
      const req = createMockRequest("http://localhost:3000/api/auth/unlock", {
        method: "POST",
        body: { action: "lock" },
      });
      const res = await POST(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect(data).toEqual({ success: true });
      // Verify session cookie was cleared
      const setCookie = res.headers.get("set-cookie");
      expect(setCookie).toContain("pf_session=");
      expect(setCookie).toContain("Max-Age=0");
    });

    it("returns 429 when rate limited", async () => {
      mockCheckRateLimit.mockReturnValue({ allowed: false, remaining: 0, resetAt: Date.now() + 30000 });
      const req = createMockRequest("http://localhost:3000/api/auth/unlock", {
        method: "POST",
        body: { action: "unlock", passphrase: "test" },
      });
      const res = await POST(req);
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBeDefined();
    });

    it("returns 400 for invalid JSON", async () => {
      const req = new Request("http://localhost:3000/api/auth/unlock", {
        method: "POST",
        body: "not json",
        headers: { "Content-Type": "text/plain" },
      });
      const res = await POST(req as unknown as import("next/server").NextRequest);
      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid passphrase on setup", async () => {
      const req = createMockRequest("http://localhost:3000/api/auth/unlock", {
        method: "POST",
        body: { action: "setup", passphrase: "short" },
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("defaults action to unlock", async () => {
      const req = createMockRequest("http://localhost:3000/api/auth/unlock", {
        method: "POST",
        body: { passphrase: "my-passphrase" },
      });
      const res = await POST(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect(data).toEqual({ success: true });
    });
  });
});
