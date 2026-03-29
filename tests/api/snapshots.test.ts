import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDbChain: Record<string, ReturnType<typeof vi.fn>> = {};
const chainMethods = ["select", "from", "where", "orderBy", "leftJoin", "insert", "delete", "values", "returning"];
for (const m of chainMethods) {
  mockDbChain[m] = vi.fn().mockReturnValue(mockDbChain);
}
mockDbChain.all = vi.fn().mockReturnValue([]);
mockDbChain.get = vi.fn().mockReturnValue(undefined);
mockDbChain.run = vi.fn();

vi.mock("@/db", () => ({
  db: new Proxy({}, {
    get: (_t, prop) => mockDbChain[prop as string] ?? vi.fn().mockReturnValue(mockDbChain),
  }),
  schema: {
    snapshots: { id: "id", accountId: "accountId", date: "date", value: "value", note: "note", userId: "userId" },
    accounts: { id: "id", name: "name" },
  },
}));

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "default", method: "passphrase" as const, mfaVerified: false } })),
}));
vi.mock("drizzle-orm", () => ({ eq: vi.fn(), desc: vi.fn(), and: vi.fn() }));

import { GET, POST, DELETE } from "@/app/api/snapshots/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

describe("API /api/snapshots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const m of chainMethods) mockDbChain[m]!.mockReturnValue(mockDbChain);
    mockDbChain.all!.mockReturnValue([]);
    mockDbChain.get!.mockReturnValue(undefined);
  });

  describe("GET", () => {
    it("returns snapshots", async () => {
      const snaps = [{ id: 1, accountId: 1, accountName: "Savings", date: "2024-01-01", value: 10000, note: "" }];
      mockDbChain.all!.mockReturnValueOnce(snaps);
      const req = createMockRequest("http://localhost:3000/api/snapshots");
      const res = await GET(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect(data).toEqual(snaps);
    });
  });

  describe("POST", () => {
    it("creates snapshot", async () => {
      const snap = { id: 1, accountId: 1, date: "2024-01-01", value: 10000 };
      mockDbChain.get!.mockReturnValueOnce(snap);
      const req = createMockRequest("http://localhost:3000/api/snapshots", {
        method: "POST",
        body: { accountId: 1, date: "2024-01-01", value: 10000 },
      });
      const res = await POST(req);
      const { status } = await parseResponse(res);
      expect(status).toBe(201);
    });

    it("returns 400 for missing fields", async () => {
      const req = createMockRequest("http://localhost:3000/api/snapshots", {
        method: "POST",
        body: { accountId: 1 },
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE", () => {
    it("deletes snapshot", async () => {
      const req = createMockRequest("http://localhost:3000/api/snapshots?id=1", { method: "DELETE" });
      const res = await DELETE(req);
      const { data } = await parseResponse(res);
      expect(data).toEqual({ success: true });
    });

    it("returns 400 without id", async () => {
      const req = createMockRequest("http://localhost:3000/api/snapshots", { method: "DELETE" });
      const res = await DELETE(req);
      expect(res.status).toBe(400);
    });
  });
});
