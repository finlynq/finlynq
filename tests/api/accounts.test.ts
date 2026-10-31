import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "default", method: "passphrase" as const, mfaVerified: false, dek: Buffer.alloc(32, 0xaa), sessionId: "test-session-jti" } })),
}));

const mockGetAccounts = vi.fn();
const mockCreateAccount = vi.fn();
const mockGetAccountById = vi.fn();
const mockUpdateAccount = vi.fn();
const mockDeleteAccount = vi.fn();
vi.mock("@/lib/queries", () => ({
  getAccounts: (...args: unknown[]) => mockGetAccounts(...args),
  createAccount: (...args: unknown[]) => mockCreateAccount(...args),
  getAccountById: (...args: unknown[]) => mockGetAccountById(...args),
  updateAccount: (...args: unknown[]) => mockUpdateAccount(...args),
  deleteAccount: (...args: unknown[]) => mockDeleteAccount(...args),
}));

/** A Postgres unique-violation as `pg` surfaces it. */
function uniqueViolation(constraint: string): Error {
  return Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
    code: "23505",
    constraint,
  });
}

/**
 * The same violation as Drizzle rethrows it: a "Failed query: insert into
 * \"accounts\" …" wrapper whose `.cause` is the pg error. This is the exact
 * shape prod logged on 2026-10-28 20:13 (a duplicate EUR investment account).
 */
function drizzleWrappedUniqueViolation(constraint: string): Error {
  return Object.assign(
    new Error('Failed query: insert into "accounts" ("user_id", "type", "group", "currency") values ($1, $2, $3, $4)'),
    { cause: uniqueViolation(constraint) },
  );
}

import { GET, POST, PUT } from "@/app/api/accounts/route";
import { requireAuth } from "@/lib/auth/require-auth";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";
import { NextResponse } from "next/server";

describe("API /api/accounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET", () => {
    it("returns 401 when not authenticated", async () => {
      vi.mocked(requireAuth).mockResolvedValueOnce({
        authenticated: false,
        response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
      });
      const req = createMockRequest("http://localhost:3000/api/accounts");
      const res = await GET(req);
      const { status } = await parseResponse(res);
      expect(status).toBe(401);
    });

    it("returns list of accounts", async () => {
      // Stream D Phase 4 — plaintext name dropped; route returns rows as-is
      // and decryptNamedRows overwrites `name`/`alias` based on `*_ct` only
      // when present. Without nameCt the decrypted name is null. Test data
      // has no ct so we just assert the shape comes through (with name set
      // to null by the decrypt path).
      const accounts = [
        { id: 1, type: "A", group: "Banking", currency: "CAD", note: "", nameCt: null, aliasCt: null },
        { id: 2, type: "L", group: "Credit", currency: "CAD", note: "", nameCt: null, aliasCt: null },
      ];
      mockGetAccounts.mockReturnValue(accounts);
      const req = createMockRequest("http://localhost:3000/api/accounts");
      const res = await GET(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
      const arr = data as Array<Record<string, unknown>>;
      expect(arr).toHaveLength(2);
      expect(arr[0]).toMatchObject({ id: 1, type: "A", group: "Banking", currency: "CAD" });
      expect(arr[1]).toMatchObject({ id: 2, type: "L", group: "Credit", currency: "CAD" });
    });

    it("returns empty array when no accounts exist", async () => {
      mockGetAccounts.mockReturnValue([]);
      const req = createMockRequest("http://localhost:3000/api/accounts");
      const res = await GET(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect(data).toEqual([]);
    });
  });

  describe("POST", () => {
    it("creates a new account with valid data", async () => {
      // Stream D Phase 4 — plaintext name dropped; route handler no longer
      // forwards `name` to createAccount, only the type/group/currency. The
      // encrypted name siblings come from buildNameFields(); without a DEK
      // mock those land as empty so we don't assert on them here.
      const newAccount = { id: 3, type: "A", group: "Banking", currency: "CAD" };
      mockCreateAccount.mockReturnValue(newAccount);
      const req = createMockRequest("http://localhost:3000/api/accounts", {
        method: "POST",
        body: { name: "Savings", type: "A", group: "Banking", currency: "CAD" },
      });
      const res = await POST(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(201);
      expect(data).toEqual(newAccount);
      expect(mockCreateAccount).toHaveBeenCalledWith(
        "default",
        expect.objectContaining({ type: "A", group: "Banking", currency: "CAD" }),
      );
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

    it("returns 401 when not authenticated", async () => {
      vi.mocked(requireAuth).mockResolvedValueOnce({
        authenticated: false,
        response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
      });
      const req = createMockRequest("http://localhost:3000/api/accounts", {
        method: "POST",
        body: { name: "Test", type: "A", group: "G", currency: "CAD" },
      });
      const res = await POST(req);
      expect(res.status).toBe(401);
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

    // Prod diagnostics_log 2026-10-28 20:13: a second account with an existing
    // name tripped accounts_user_name_lookup_uniq and surfaced as a raw 500.
    it("returns 409, not 500, when the name is already taken", async () => {
      mockCreateAccount.mockRejectedValue(uniqueViolation("accounts_user_name_lookup_uniq"));
      const req = createMockRequest("http://localhost:3000/api/accounts", {
        method: "POST",
        body: { name: "Savings", type: "A", group: "Investment", currency: "EUR", isInvestment: true },
      });
      const res = await POST(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(409);
      expect((data as { error: string }).error).toMatch(/account with this name already exists/i);
      expect((data as { error: string }).error).not.toMatch(/failed query/i);
    });

    it("unwraps the Drizzle 'Failed query' wrapper to find the 23505", async () => {
      mockCreateAccount.mockRejectedValue(drizzleWrappedUniqueViolation("accounts_user_name_lookup_uniq"));
      const req = createMockRequest("http://localhost:3000/api/accounts", {
        method: "POST",
        body: { name: "Savings", type: "A", group: "Banking", currency: "EUR" },
      });
      const res = await POST(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(409);
      expect((data as { error: string }).error).toMatch(/account with this name already exists/i);
    });

    it("still 500s on an unrelated unique violation", async () => {
      mockCreateAccount.mockRejectedValue(uniqueViolation("some_other_uniq"));
      const req = createMockRequest("http://localhost:3000/api/accounts", {
        method: "POST",
        body: { name: "Savings", type: "A", group: "Banking", currency: "EUR" },
      });
      const res = await POST(req);
      expect(res.status).toBe(500);
    });
  });

  describe("PUT", () => {
    it("updates an account", async () => {
      const updated = { id: 1, type: "A", group: "Banking", currency: "CAD" };
      mockUpdateAccount.mockResolvedValue(updated);
      const req = createMockRequest("http://localhost:3000/api/accounts", {
        method: "PUT",
        body: { id: 1, name: "Renamed" },
      });
      const res = await PUT(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect(data).toEqual(updated);
    });

    it("returns 400 without id", async () => {
      const req = createMockRequest("http://localhost:3000/api/accounts", {
        method: "PUT",
        body: { name: "Renamed" },
      });
      const res = await PUT(req);
      expect(res.status).toBe(400);
    });

    it("returns 409, not 500, when renaming onto an existing name", async () => {
      mockUpdateAccount.mockRejectedValue(drizzleWrappedUniqueViolation("accounts_user_name_lookup_uniq"));
      const req = createMockRequest("http://localhost:3000/api/accounts", {
        method: "PUT",
        body: { id: 1, name: "Chequing" },
      });
      const res = await PUT(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(409);
      expect((data as { error: string }).error).toMatch(/account with this name already exists/i);
    });

    it("still 500s on an unrelated unique violation", async () => {
      mockUpdateAccount.mockRejectedValue(uniqueViolation("some_other_uniq"));
      const req = createMockRequest("http://localhost:3000/api/accounts", {
        method: "PUT",
        body: { id: 1, name: "Chequing" },
      });
      const res = await PUT(req);
      expect(res.status).toBe(500);
    });
  });
});
