import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/require-unlock", () => ({
  requireUnlock: vi.fn(() => null),
}));

const mockGetAccounts = vi.fn();
const mockCreateAccount = vi.fn();
vi.mock("@/lib/queries", () => ({
  getAccounts: (...args: unknown[]) => mockGetAccounts(...args),
  createAccount: (...args: unknown[]) => mockCreateAccount(...args),
}));

import { GET, POST } from "@/app/api/accounts/route";
import { requireUnlock } from "@/lib/require-unlock";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";
import { NextResponse } from "next/server";

describe("API /api/accounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET", () => {
    it("returns 423 when database is locked", async () => {
      vi.mocked(requireUnlock).mockReturnValueOnce(
        NextResponse.json({ error: "Database is locked." }, { status: 423 })
      );
      const res = await GET();
      const { status } = await parseResponse(res);
      expect(status).toBe(423);
    });

    it("returns list of accounts", async () => {
      const accounts = [
        { id: 1, type: "A", group: "Banking", name: "Checking", currency: "CAD", note: "" },
        { id: 2, type: "L", group: "Credit", name: "Visa", currency: "CAD", note: "" },
      ];
      mockGetAccounts.mockReturnValue(accounts);
      const res = await GET();
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect(data).toEqual(accounts);
    });

    it("returns empty array when no accounts exist", async () => {
      mockGetAccounts.mockReturnValue([]);
      const res = await GET();
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect(data).toEqual([]);
    });
  });

  describe("POST", () => {
    it("creates a new account with valid data", async () => {
      const newAccount = { id: 3, type: "A", group: "Banking", name: "Savings", currency: "CAD" };
      mockCreateAccount.mockReturnValue(newAccount);
      const req = createMockRequest("http://localhost:3000/api/accounts", {
        method: "POST",
        body: { name: "Savings", type: "A", group: "Banking", currency: "CAD" },
      });
      const res = await POST(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(201);
      expect(data).toEqual(newAccount);
      expect(mockCreateAccount).toHaveBeenCalledWith({
        name: "Savings", type: "A", group: "Banking", currency: "CAD",
      });
    });

    it("returns 400 for missing required fields", async () => {
      const req = createMockRequest("http://localhost:3000/api/accounts", {
        method: "POST",
        body: { name: "Test" },
      });
      const res = await POST(req);
      const { status } = await parseResponse(res);
      expect(status).toBe(400);
    });

    it("returns 423 when locked", async () => {
      vi.mocked(requireUnlock).mockReturnValueOnce(
        NextResponse.json({ error: "Database is locked." }, { status: 423 })
      );
      const req = createMockRequest("http://localhost:3000/api/accounts", {
        method: "POST",
        body: { name: "Test", type: "A", group: "G", currency: "CAD" },
      });
      const res = await POST(req);
      expect(res.status).toBe(423);
    });

    it("returns 500 on unexpected error", async () => {
      mockCreateAccount.mockImplementation(() => { throw new Error("DB error"); });
      const req = createMockRequest("http://localhost:3000/api/accounts", {
        method: "POST",
        body: { name: "Test", type: "A", group: "G", currency: "CAD" },
      });
      const res = await POST(req);
      const { status } = await parseResponse(res);
      expect(status).toBe(500);
    });

    it("accepts optional note field", async () => {
      const newAccount = { id: 4, type: "A", group: "Banking", name: "Joint", currency: "USD", note: "Shared" };
      mockCreateAccount.mockReturnValue(newAccount);
      const req = createMockRequest("http://localhost:3000/api/accounts", {
        method: "POST",
        body: { name: "Joint", type: "A", group: "Banking", currency: "USD", note: "Shared" },
      });
      const res = await POST(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(201);
      expect((data as { note: string }).note).toBe("Shared");
    });
  });
});
