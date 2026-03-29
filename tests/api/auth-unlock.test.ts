import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db", () => ({
  initializeConnection: vi.fn(),
  isUnlocked: vi.fn(() => false),
  closeConnection: vi.fn(),
  getConnection: vi.fn(() => ({ pragma: vi.fn() })),
  resetDb: vi.fn(),
}));

vi.mock("@shared/crypto", () => ({
  generateSalt: vi.fn(() => Buffer.alloc(32)),
  deriveKey: vi.fn(() => "a".repeat(64)),
}));

vi.mock("@shared/config", () => ({
  readConfig: vi.fn(() => ({ dbPath: "/tmp/test.db", mode: "local", salt: "a".repeat(64) })),
  writeConfig: vi.fn(),
  configExists: vi.fn(() => true),
  resolveDbPath: vi.fn(() => "/tmp/test.db"),
}));

vi.mock("@/db/migration", () => ({
  detectDbState: vi.fn(() => "encrypted"),
  migrateToEncrypted: vi.fn(),
}));

vi.mock("better-sqlite3-multiple-ciphers", () => {
  return { default: vi.fn() };
});

vi.mock("fs", () => ({
  default: { existsSync: vi.fn(() => true) },
  existsSync: vi.fn(() => true),
}));

const mockCheckRateLimit = vi.fn(() => ({ allowed: true, remaining: 4, resetAt: Date.now() + 60000 }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

import { GET, POST } from "@/app/api/auth/unlock/route";
import { isUnlocked, initializeConnection } from "@/db";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

describe("API /api/auth/unlock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockReturnValue({ allowed: true, remaining: 4, resetAt: Date.now() + 60000 });
  });

  describe("GET", () => {
    it("returns lock status and setup info", async () => {
      const res = await GET();
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      const d = data as { unlocked: boolean; needsSetup: boolean };
      expect(d).toHaveProperty("unlocked");
      expect(d).toHaveProperty("needsSetup");
    });

    it("reports unlocked state", async () => {
      vi.mocked(isUnlocked).mockReturnValueOnce(true);
      const res = await GET();
      const { data } = await parseResponse(res);
      expect((data as { unlocked: boolean }).unlocked).toBe(true);
    });

    it("reports locked state", async () => {
      vi.mocked(isUnlocked).mockReturnValueOnce(false);
      const res = await GET();
      const { data } = await parseResponse(res);
      expect((data as { unlocked: boolean }).unlocked).toBe(false);
    });
  });

  describe("POST", () => {
    it("unlocks with valid passphrase", async () => {
      const req = createMockRequest("http://localhost:3000/api/auth/unlock", {
        method: "POST",
        body: { action: "unlock", passphrase: "my-secure-passphrase" },
      });
      const res = await POST(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect(data).toEqual({ success: true });
      expect(initializeConnection).toHaveBeenCalled();
    });

    it("locks the database", async () => {
      const req = createMockRequest("http://localhost:3000/api/auth/unlock", {
        method: "POST",
        body: { action: "lock" },
      });
      const res = await POST(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect(data).toEqual({ success: true });
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
