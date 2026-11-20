/**
 * GH #424 follow-up — the Gemini web app called https://finlynq.com/api/mcp
 * "not a valid MCP server": a request from an unlisted Origin got 403 before
 * auth, so it never saw the 401 challenge, and the RFC 9728 metadata 404'd at
 * its standard locations.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { isAllowedMcpOrigin, shouldRejectMcpOrigin } from "@/lib/mcp/origin-guard";

const ISSUER = "https://finlynq.test";
vi.mock("@/lib/crypto/dek-cache", () => ({ getDEK: vi.fn(async () => null) }));

describe("MCP origin guard", () => {
  const base = { authorization: null, apiKey: null, hasSessionCookie: false };

  it("allows no Origin, localhost and listed hosts", () => {
    expect(isAllowedMcpOrigin(null)).toBe(true);
    expect(isAllowedMcpOrigin("http://localhost:3000")).toBe(true);
    expect(isAllowedMcpOrigin("https://claude.ai")).toBe(true);
    expect(isAllowedMcpOrigin("https://gemini.google.com")).toBe(true);
    expect(isAllowedMcpOrigin("https://evil.example")).toBe(false);
    expect(isAllowedMcpOrigin("not a url")).toBe(false);
  });

  it("an unlisted Origin without the session cookie is NOT refused (it gets the 401 challenge)", () => {
    expect(shouldRejectMcpOrigin({ ...base, origin: "https://some-new-ai.example" })).toBe(false);
  });

  it("an unlisted Origin with a bearer token or API key is judged by the token", () => {
    expect(shouldRejectMcpOrigin({ ...base, origin: "https://some-new-ai.example", authorization: "Bearer pf_oauth_x", hasSessionCookie: true })).toBe(false);
    expect(shouldRejectMcpOrigin({ ...base, origin: "https://some-new-ai.example", apiKey: "pf_abc", hasSessionCookie: true })).toBe(false);
  });

  it("an unlisted Origin riding the session cookie IS refused", () => {
    expect(shouldRejectMcpOrigin({ ...base, origin: "https://evil.example", hasSessionCookie: true })).toBe(true);
    expect(shouldRejectMcpOrigin({ ...base, origin: "https://evil.example", authorization: "Basic abc", hasSessionCookie: true })).toBe(true);
  });
});

describe("/api/mcp from an unlisted Origin", () => {
  let POST: typeof import("@/app/api/mcp/route").POST;
  let NextRequest: typeof import("next/server").NextRequest;
  beforeAll(async () => {
    process.env.APP_URL = ISSUER;
    vi.resetModules();
    ({ POST } = await import("@/app/api/mcp/route"));
    ({ NextRequest } = await import("next/server"));
  }, 60_000);

  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const req = (headers: Record<string, string>) =>
    new NextRequest(`${ISSUER}/api/mcp`, {
      method: "POST",
      body,
      headers: { "content-type": "application/json", "content-length": String(body.length), ...headers },
    });

  it("an unauthenticated probe from an unlisted AI client gets 401 + the OAuth challenge, not 403", async () => {
    // Deliberately NOT gemini.google.com (now listed): the point is that an
    // Origin nobody has listed yet still reaches the OAuth challenge.
    const res = await POST(req({ origin: "https://some-new-ai.example" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/resource_metadata=/);
  });

  it("an unlisted site riding the session cookie still gets 403", async () => {
    const res = await POST(req({ origin: "https://evil.example", cookie: "pf_session=abc" }));
    expect(res.status).toBe(403);
  });
});

describe("RFC 9728 metadata at the standard locations", () => {
  it("serves the same document at /.well-known/oauth-protected-resource[/api/mcp]", async () => {
    process.env.APP_URL = ISSUER;
    vi.resetModules();
    const original = await (await (await import("@/app/api/mcp/.well-known/oauth-protected-resource/route")).GET()).json();
    const root = await (await (await import("@/app/.well-known/oauth-protected-resource/route")).GET()).json();
    const inserted = await (await (await import("@/app/.well-known/oauth-protected-resource/api/mcp/route")).GET()).json();
    expect(root).toEqual(original);
    expect(inserted).toEqual(original);
    expect(original.resource).toBe(`${ISSUER}/api/mcp`);
    expect(original.authorization_servers).toEqual([ISSUER]);
  });
});
