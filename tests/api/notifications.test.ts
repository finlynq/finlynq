import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDbChain: Record<string, ReturnType<typeof vi.fn>> = {};
const chainMethods = ["select", "from", "where", "orderBy", "leftJoin", "insert", "update", "delete", "values", "set", "returning", "groupBy", "limit"];
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
    notifications: { id: "id", type: "type", title: "title", message: "message", read: "read", createdAt: "createdAt", metadata: "metadata" },
    budgets: { id: "id", categoryId: "categoryId", month: "month", amount: "amount" },
    categories: { id: "id", name: "name" },
    transactions: { date: "date", amount: "amount", categoryId: "categoryId" },
  },
}));

vi.mock("@/lib/require-unlock", () => ({ requireUnlock: vi.fn(() => null) }));
vi.mock("drizzle-orm", () => ({ eq: vi.fn(), desc: vi.fn(), sql: vi.fn() }));

import { GET, POST } from "@/app/api/notifications/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

describe("API /api/notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const m of chainMethods) mockDbChain[m]!.mockReturnValue(mockDbChain);
    mockDbChain.all!.mockReturnValue([]);
    mockDbChain.get!.mockReturnValue({ count: 0 });
  });

  describe("GET", () => {
    it("returns notifications with unread count", async () => {
      const notifs = [{ id: 1, type: "info", title: "Test", message: "Hello", read: 0, createdAt: "2024-01-01" }];
      mockDbChain.all!.mockReturnValueOnce(notifs);
      mockDbChain.get!.mockReturnValueOnce({ count: 1 });
      const res = await GET();
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      const d = data as { notifications: unknown[]; unreadCount: number };
      expect(d.notifications).toEqual(notifs);
      expect(d.unreadCount).toBe(1);
    });
  });

  describe("POST", () => {
    it("marks single notification as read", async () => {
      const req = createMockRequest("http://localhost:3000/api/notifications", {
        method: "POST",
        body: { action: "mark-read", id: 1 },
      });
      const res = await POST(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect(data).toEqual({ success: true });
    });

    it("marks all notifications as read", async () => {
      const req = createMockRequest("http://localhost:3000/api/notifications", {
        method: "POST",
        body: { action: "mark-read" },
      });
      const res = await POST(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect(data).toEqual({ success: true });
    });

    it("generates budget alerts", async () => {
      mockDbChain.all!.mockReturnValueOnce([]);
      const req = createMockRequest("http://localhost:3000/api/notifications", {
        method: "POST",
        body: { action: "generate" },
      });
      const res = await POST(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect(data).toHaveProperty("generated");
    });

    it("creates custom notification", async () => {
      const notif = { id: 1, type: "info", title: "Custom", message: "Hello" };
      mockDbChain.get!.mockReturnValueOnce(notif);
      const req = createMockRequest("http://localhost:3000/api/notifications", {
        method: "POST",
        body: { title: "Custom", message: "Hello" },
      });
      const res = await POST(req);
      const { status } = await parseResponse(res);
      expect(status).toBe(201);
    });
  });
});
