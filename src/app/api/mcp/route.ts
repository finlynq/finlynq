/**
 * Finlynq MCP Endpoint — Streamable HTTP transport (stateless mode)
 *
 * Stateless: each POST is fully self-contained — no session tracking needed.
 * enableJsonResponse: true — returns JSON (not SSE), required by Claude's
 * remote MCP connector and most other clients.
 *
 * Auth (checked in order):
 *   1. Authorization: Bearer pf_oauth_<token>  ← OAuth 2.1 access token
 *   2. Authorization: Bearer pf_<key>          ← API key (Claude custom connector)
 *   3. X-API-Key: pf_<key>                     ← direct API key header
 *   4. Session cookie                          ← browser session
 */

import { NextRequest, NextResponse } from "next/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { db } from "@/db";
import { requireAuth } from "@/lib/auth/require-auth";
import { accountStrategy } from "@/lib/auth/require-auth";
import { validateOauthToken, getIssuer } from "@/lib/oauth";
import { DEFAULT_SCOPE, parseScope, isToolAllowedForScope } from "@/lib/oauth-scopes";
import { checkRateLimit } from "@/lib/rate-limit";
import { registerPgTools } from "../../../../mcp-server/register-tools-pg";

/**
 * Authenticate for MCP: OAuth token > API key > session cookie.
 */
async function authenticateMcp(request: NextRequest) {
  const authHeader = request.headers.get("authorization") ?? "";

  // 1. OAuth 2.1 access token (pf_oauth_...)
  const oauthCandidate = authHeader.startsWith("Bearer pf_oauth_") ? authHeader.slice(7) : null;
  if (oauthCandidate) {
    const result = await validateOauthToken(oauthCandidate);
    if (result) {
      return {
        authenticated: true as const,
        context: { userId: result.userId, method: "oauth" as const, mfaVerified: false, dek: result.dek, sessionId: null as string | null, scope: result.scope },
      };
    }
    // Token looks like OAuth but failed validation — return 401 with WWW-Authenticate
    const issuer = getIssuer();
    return {
      authenticated: false as const,
      response: NextResponse.json(
        { error: "invalid_token", error_description: "OAuth access token is invalid or expired" },
        { status: 401, headers: { "WWW-Authenticate": `Bearer realm="${issuer}", error="invalid_token"` } }
      ),
    };
  }

  // 2 & 3. API key (pf_...) or X-API-Key header
  const hasApiKey =
    request.headers.get("X-API-Key") ||
    authHeader.startsWith("Bearer pf_");

  if (hasApiKey) {
    return requireAuth(request);
  }

  // 4. Session cookie
  const sessionResult = await accountStrategy.authenticate(request);
  if (sessionResult.authenticated) return sessionResult;

  // Nothing matched — return 401 with WWW-Authenticate pointing to OAuth
  const issuer = getIssuer();
  return {
    authenticated: false as const,
    response: NextResponse.json(
      { error: "unauthorized", error_description: "Authentication required" },
      {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer realm="${issuer}", resource_metadata="${issuer}/api/mcp/.well-known/oauth-protected-resource"`,
        },
      }
    ),
  };
}

// M-21 (SECURITY_REVIEW 2026-05-06): cap MCP request bodies at 1 MB. The MCP
// surface is auth-gated, but a logged-in attacker (or a buggy client) could
// otherwise stream an unbounded payload — JSON parsing happens inside the
// SDK transport with no size guard. 1 MB comfortably exceeds any legitimate
// MCP message; staging upload (the largest legitimate body) goes through
// /api/import/staging/upload, not here.
const MCP_MAX_BODY_BYTES = 1 * 1024 * 1024;

// POST — MCP messages (initialize + tool calls)
export async function POST(request: NextRequest) {
  // Pre-check Content-Length BEFORE auth so we don't parse / buffer huge
  // bodies when we'll reject. Mirror the pattern in
  // /api/import/staging/upload/route.ts:91-97. We require the header — MCP
  // clients all send Content-Length, and chunked uploads are not expected
  // on this endpoint.
  const contentLengthRaw = request.headers.get("content-length");
  if (contentLengthRaw == null) {
    return NextResponse.json(
      { error: "Content-Length header required" },
      { status: 411 },
    );
  }
  const contentLength = Number(contentLengthRaw);
  if (!Number.isFinite(contentLength) || contentLength < 0) {
    return NextResponse.json(
      { error: "Invalid Content-Length header" },
      { status: 400 },
    );
  }
  if (contentLength > MCP_MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: `Request body exceeds ${MCP_MAX_BODY_BYTES} byte limit` },
      { status: 413 },
    );
  }

  const auth = await authenticateMcp(request);
  if (!auth.authenticated) return auth.response;

  // Rate limit MCP requests per user: 60 requests per minute
  const rl = checkRateLimit(`mcp:${auth.context.userId}`, 60, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded for MCP endpoint" },
      { status: 429, headers: { "Retry-After": String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } }
    );
  }

  const server = new McpServer({ name: "finlynq", version: "2.3.0" });

  // Resolve the effective scope for this request. OAuth tokens carry a stored
  // scope; API-key / session-cookie auth defaults to DEFAULT_SCOPE (full
  // read+write — those auth methods predate scope plumbing and remain
  // unrestricted). When scope is narrower than full, wrap server.tool() so
  // every out-of-scope tool registration becomes a no-op — the SDK never
  // even learns about those tools, so they don't appear in tools/list and
  // can't be called.
  const scopeString = "scope" in auth.context ? auth.context.scope : DEFAULT_SCOPE;
  const scopeSet = parseScope(scopeString);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const originalTool = (server as any).tool.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).tool = (name: string, ...args: unknown[]) => {
    if (!isToolAllowedForScope(name, scopeSet)) {
      // Drop registration silently — out-of-scope tools shouldn't surface in
      // tools/list as "I exist but you can't call me", because that leaks
      // information about what the broader API supports. The OAuth dance
      // already told the client which scope it asked for.
      return undefined;
    }
    return originalTool(name, ...args);
  };

  // PostgreSQL-only mode — async Drizzle queries, user-scoped.
  // DEK comes from whichever auth path we matched: API-key envelope, session
  // cookie cache, or null for OAuth (OAuth DEK envelope is Phase 3).
  const dek = "dek" in auth.context ? auth.context.dek : null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerPgTools(server, db as any, auth.context.userId, dek);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no session tracking
    enableJsonResponse: true,      // JSON responses, not SSE
  });

  await server.connect(transport);
  return transport.handleRequest(request);
}

// GET — return 401 with WWW-Authenticate so MCP clients can discover OAuth endpoints
export async function GET() {
  const issuer = getIssuer();
  return NextResponse.json(
    { error: "Finlynq MCP requires authentication. Use POST with a valid Bearer token." },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer realm="${issuer}", resource_metadata="${issuer}/api/mcp/.well-known/oauth-protected-resource"`,
      },
    }
  );
}

// DELETE — not used in stateless mode
export async function DELETE() {
  return Response.json(
    { error: "Stateless mode — no sessions to delete." },
    { status: 405, headers: { Allow: "POST" } }
  );
}
