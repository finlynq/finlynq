import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "default", method: "passphrase" as const, mfaVerified: false } })),
}));

vi.mock("@shared/config", () => ({
  readConfig: vi.fn(() => ({ dbPath: "/data/pf.db", mode: "local", salt: "abc" })),
  writeConfig: vi.fn(),
  resolveDbPath: vi.fn(() => "/data/pf.db"),
}));

vi.mock("@/db", () => ({
  getMode: vi.fn(() => "local"),
  getDbPath: vi.fn(() => "/data/pf.db"),
  isCloudReadOnly: vi.fn(() => false),
}));

vi.mock("fs", () => ({
  default: { statSync: vi.fn(() => ({ size: 1024000 })) },
  statSync: vi.fn(() => ({ size: 1024000 })),
}));

import { GET, PUT } from "@/app/api/settings/storage/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

describe("API /api/settings/storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET", () => {
    it("returns storage settings", async () => {
      const req = createMockRequest("http://localhost:3000/api/settings/storage");
      const res = await GET(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      const d = data as Record<string, unknown>;
      expect(d).toHaveProperty("dbPath");
      expect(d).toHaveProperty("mode");
      expect(d).toHaveProperty("fileSize");
    });
  });

  describe("PUT", () => {
    it("updates storage path", async () => {
      const req = createMockRequest("http://localhost:3000/api/settings/storage", {
        method: "PUT",
        body: { dbPath: "/new/path/pf.db" },
      });
      const res = await PUT(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect((data as { success: boolean }).success).toBe(true);
    });

    it("updates mode to cloud", async () => {
      const req = createMockRequest("http://localhost:3000/api/settings/storage", {
        method: "PUT",
        body: { mode: "cloud" },
      });
      const res = await PUT(req);
      expect(res.status).toBe(200);
    });

    it("returns 400 for invalid mode", async () => {
      const req = createMockRequest("http://localhost:3000/api/settings/storage", {
        method: "PUT",
        body: { mode: "invalid" },
      });
      const res = await PUT(req);
      expect(res.status).toBe(400);
    });
  });
});
