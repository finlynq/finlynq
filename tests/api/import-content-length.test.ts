/**
 * Regression test for M-22 (security/B9): /api/import (legacy CSV
 * upload) gained a 20 MB Content-Length pre-check and switched from
 * `requireAuth` to `requireEncryption`.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/db", () => ({ db: {}, schema: {} }));
vi.mock("@/lib/auth/require-encryption", () => ({
  requireEncryption: vi.fn(async () => ({ ok: true, userId: "u1", dek: Buffer.alloc(32), sessionId: "s1" })),
}));
// Pull the import functions but they should never be reached in these
// guard-path tests.
vi.mock("@/lib/csv-parser", () => ({
  importAccounts: vi.fn(async () => ({ inserted: 0 })),
  importCategories: vi.fn(async () => ({ inserted: 0 })),
  importPortfolio: vi.fn(async () => ({ inserted: 0 })),
  importTransactions: vi.fn(async () => ({ inserted: 0 })),
}));

import { POST } from "@/app/api/import/route";
import { NextRequest } from "next/server";

function makeReq(headers: Record<string, string>): NextRequest {
  const init = {
    method: "POST",
    headers,
    // Body is irrelevant — the size check fires before formData() is read.
    body: "",
  };
  return new NextRequest("http://localhost:3000/api/import", init as unknown as ConstructorParameters<typeof NextRequest>[1]);
}

describe("/api/import — Content-Length cap (M-22)", () => {
  it("rejects bodies > 20 MB with 413", async () => {
    const oversize = String(21 * 1024 * 1024);
    const res = await POST(makeReq({ "content-length": oversize, "content-type": "multipart/form-data" }));
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toMatch(/too large/i);
  });

  it("accepts bodies under the cap (proceeds past the size guard)", async () => {
    const okSize = String(1024); // 1 KB
    // No multipart body to parse, so we expect a 400 from the missing-file
    // / missing-type branch downstream — NOT a 413.
    const res = await POST(makeReq({ "content-length": okSize, "content-type": "multipart/form-data" }));
    expect(res.status).not.toBe(413);
  });
});
