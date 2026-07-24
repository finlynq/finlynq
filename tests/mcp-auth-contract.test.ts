/**
 * GH #318 — HTTP contract guards for the MCP endpoint's auth surface.
 *
 * These four bugs were only ever visible through a real MCP client, so the
 * cheap unit-level guard is the wire contract itself: the status code on GET
 * and the shape of every WWW-Authenticate challenge. All four are one-line
 * regressions waiting to happen.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// getIssuer() reads APP_URL at call time.
const ISSUER = "https://finlynq.test";
const RESOURCE_METADATA = `${ISSUER}/api/mcp/.well-known/oauth-protected-resource`;

vi.mock("@/lib/crypto/dek-cache", () => ({ getDEK: vi.fn(async () => null) }));

describe("bearerChallenge — GH #318 bug 3", () => {
  beforeEach(() => {
    process.env.APP_URL = ISSUER;
    vi.resetModules();
  });

  it("ALWAYS includes resource_metadata, with and without an error", async () => {
    const { bearerChallenge } = await import("@/lib/oauth");
    // The bug: the invalid_token branch omitted resource_metadata, so a client
    // whose token went stale could not rediscover the resource on re-auth.
    expect(bearerChallenge()).toContain(`resource_metadata="${RESOURCE_METADATA}"`);
    expect(bearerChallenge({ error: "invalid_token" })).toContain(
      `resource_metadata="${RESOURCE_METADATA}"`
    );
  });

  it("emits error= only when a token was actually presented", async () => {
    const { bearerChallenge } = await import("@/lib/oauth");
    expect(bearerChallenge()).not.toContain("error=");
    expect(bearerChallenge({ error: "invalid_token" })).toContain(`error="invalid_token"`);
  });

  it("is a well-formed RFC 6750 Bearer challenge", async () => {
    const { bearerChallenge } = await import("@/lib/oauth");
    expect(bearerChallenge({ error: "invalid_token" })).toBe(
      `Bearer realm="${ISSUER}", resource_metadata="${RESOURCE_METADATA}", error="invalid_token"`
    );
  });
});

describe("GET /api/mcp — GH #318 bug 4 (the re-auth loop)", () => {
  beforeEach(() => {
    process.env.APP_URL = ISSUER;
    vi.resetModules();
  });

  it("returns 405 + Allow: POST, NOT 401", async () => {
    const { GET } = await import("@/app/api/mcp/route");
    const { NextRequest } = await import("next/server");
    const res = await GET(new NextRequest(`${ISSUER}/api/mcp`, { method: "GET" }));

    // 401 here is what made StreamableHTTPClientTransport._startOrAuthSse
    // re-authenticate forever. The spec requires 405 when the server offers
    // no SSE stream at the endpoint.
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  it("does NOT advertise a Bearer challenge (that re-arms the auth reflex)", async () => {
    const { GET } = await import("@/app/api/mcp/route");
    const { NextRequest } = await import("next/server");
    const res = await GET(new NextRequest(`${ISSUER}/api/mcp`, { method: "GET" }));
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
  });

  it("still 405s when a valid-looking Bearer token IS supplied", async () => {
    // The old handler ignored Authorization entirely; the new one must not
    // start authenticating here either — there is simply no SSE stream.
    const { GET } = await import("@/app/api/mcp/route");
    const { NextRequest } = await import("next/server");
    const res = await GET(
      new NextRequest(`${ISSUER}/api/mcp`, {
        method: "GET",
        headers: { authorization: "Bearer pf_oauth_whatever" },
      })
    );
    expect(res.status).toBe(405);
  });
});

describe("OAuth metadata — GH #318 bug 1", () => {
  beforeEach(() => {
    process.env.APP_URL = ISSUER;
    vi.resetModules();
  });

  it("authorization-server metadata advertises scopes_supported", async () => {
    const { GET } = await import("@/app/.well-known/oauth-authorization-server/route");
    const body = await (await GET()).json();
    expect(body.scopes_supported).toEqual(["mcp:read", "mcp:write"]);
  });

  it("protected-resource metadata advertises scopes_supported", async () => {
    const { GET } = await import("@/app/api/mcp/.well-known/oauth-protected-resource/route");
    const body = await (await GET()).json();
    expect(body.scopes_supported).toEqual(["mcp:read", "mcp:write"]);
    // This document is what resource_metadata points at — keep them consistent.
    expect(body.resource).toBe(`${ISSUER}/api/mcp`);
  });
});
