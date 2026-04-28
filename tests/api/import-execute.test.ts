import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "default", method: "passphrase" as const, mfaVerified: false } })),
}));

const mockExecuteImport = vi.fn();
vi.mock("@/lib/import-pipeline", () => ({
  executeImport: (...a: unknown[]) => mockExecuteImport(...a),
}));

import { POST } from "@/app/api/import/execute/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

describe("API /api/import/execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteImport.mockReturnValue({ imported: 5, duplicates: 1, errors: 0 });
  });

  it("executes import with rows", async () => {
    const rows = [
      { date: "2024-01-15", amount: -50, account: "Checking", category: "Food", currency: "CAD" },
    ];
    const req = createMockRequest("http://localhost:3000/api/import/execute", {
      method: "POST",
      body: { rows },
    });
    const res = await POST(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data).toEqual({ imported: 5, duplicates: 1, errors: 0 });
  });

  it("passes force import indices", async () => {
    const req = createMockRequest("http://localhost:3000/api/import/execute", {
      method: "POST",
      body: { rows: [{ date: "2024-01-15", amount: -50 }], forceImportIndices: [0] },
    });
    await POST(req);
    expect(mockExecuteImport).toHaveBeenCalledWith(
      expect.any(Array),
      [0],
      "default"
    );
  });

  it("returns 400 for empty rows", async () => {
    const req = createMockRequest("http://localhost:3000/api/import/execute", {
      method: "POST",
      body: { rows: [] },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 500 when import throws", async () => {
    mockExecuteImport.mockImplementation(() => { throw new Error("Import error"); });
    const req = createMockRequest("http://localhost:3000/api/import/execute", {
      method: "POST",
      body: { rows: [{ date: "2024-01-15", amount: -50 }] },
    });
    const res = await POST(req);
    expect(res.status).toBe(500);
  });
});
