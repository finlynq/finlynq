import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "default", method: "passphrase" as const, mfaVerified: false } })),
}));

vi.mock("@/db", () => ({
  getMode: vi.fn(() => "local"),
  getDbPath: vi.fn(() => "/data/pf.db"),
  isCloudReadOnly: vi.fn(() => false),
}));

vi.mock("@/db/sync", () => ({
  checkLock: vi.fn(() => ({ locked: false, owner: null })),
  forceReleaseLock: vi.fn(),
  acquireLock: vi.fn(() => true),
}));

vi.mock("@/db/sync-checks", () => ({
  findConflictFiles: vi.fn(() => []),
}));

import { GET, POST } from "@/app/api/settings/sync-status/route";
import { getMode } from "@/db";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

describe("API /api/settings/sync-status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET", () => {
    it("returns local mode info when not in cloud", async () => {
      const req = createMockRequest("http://localhost:3000/api/settings/sync-status");
      const res = await GET(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect((data as { mode: string }).mode).toBe("local");
    });

    it("returns cloud sync status when in cloud mode", async () => {
      vi.mocked(getMode).mockReturnValue("cloud");
      const req = createMockRequest("http://localhost:3000/api/settings/sync-status");
      const res = await GET(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      const d = data as Record<string, unknown>;
      expect(d.mode).toBe("cloud");
      expect(d).toHaveProperty("lock");
      expect(d).toHaveProperty("conflictFiles");
    });
  });

  describe("POST", () => {
    it("force releases lock", async () => {
      const req = createMockRequest("http://localhost:3000/api/settings/sync-status", {
        method: "POST",
        body: { action: "force-release" },
      });
      const res = await POST(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect((data as { success: boolean }).success).toBe(true);
    });

    it("returns 400 for unknown action", async () => {
      const req = createMockRequest("http://localhost:3000/api/settings/sync-status", {
        method: "POST",
        body: { action: "unknown" },
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });
  });
});
