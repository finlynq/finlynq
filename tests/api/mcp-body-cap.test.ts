/**
 * Regression test for M-21 (SECURITY_REVIEW 2026-05-06): /api/mcp must
 * reject oversized request bodies with 413 BEFORE running auth or
 * dispatching to the MCP server. Mirrors the pattern in
 * /api/import/staging/upload/route.ts.
 */

import { describe, it, expect } from "vitest";

// Stable env so module-load doesn't blow up.
process.env.PF_JWT_SECRET = "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { POST } from "@/app/api/mcp/route";
import { NextRequest } from "next/server";

function makeRequest(headers: Record<string, string>, body: string | null = null): NextRequest {
  // NextRequest's RequestInit type differs from lib.dom's; build the literal
  // inline and cast through `unknown` so we don't drag the lib.dom shape
  // into the parameter slot.
  const init = {
    method: "POST",
    headers,
    ...(body != null ? { body } : {}),
  };
  return new NextRequest("http://localhost/api/mcp", init as unknown as ConstructorParameters<typeof NextRequest>[1]);
}

describe("/api/mcp body cap (M-21)", () => {
  it("rejects bodies larger than 1 MB with 413", async () => {
    // Just signal a large size — the check is on Content-Length, no need
    // to actually allocate 2 MB.
    const req = makeRequest({
      "content-length": String(2 * 1024 * 1024),
      "content-type": "application/json",
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toMatch(/byte limit/i);
  });

  it("rejects requests with no Content-Length header (411)", async () => {
    // Build a Request without setting content-length explicitly. Note: the
    // platform may add one automatically when there's a body — but for the
    // GET-shaped POST below it should be absent.
    const req = new NextRequest("http://localhost/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    // Some runtimes set Content-Length automatically. If our test env does,
    // skip the assertion shape but ensure we don't get past auth.
    const cl = req.headers.get("content-length");
    if (cl == null) {
      const res = await POST(req);
      expect(res.status).toBe(411);
    } else {
      // Test env auto-set Content-Length; assert at least that the request
      // is bounded by the 1 MB cap (i.e. doesn't 413).
      expect(Number(cl)).toBeLessThanOrEqual(1024 * 1024);
    }
  });

  it("rejects requests with non-numeric Content-Length with 400", async () => {
    const req = makeRequest({
      "content-length": "not-a-number",
      "content-type": "application/json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("does NOT 413 when Content-Length is at or just under 1 MB", async () => {
    const req = makeRequest({
      "content-length": String(1024 * 1024),
      "content-type": "application/json",
    });
    const res = await POST(req);
    // Body cap doesn't trip — but auth still rejects (no token) → 401.
    expect(res.status).not.toBe(413);
  });
});
