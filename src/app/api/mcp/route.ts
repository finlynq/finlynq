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
 *   4. ?token=pf_<key>                         ← URL query parameter
 *   5. Session cookie                          ← browser session
 */

import { NextRequest, NextResponse } from "next/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getDialect, getConnection } from "@/db";
import { db } from "@/db";
import { requireAuth } from "@/lib/auth/require-auth";
import { accountStrategy } from "@/lib/auth/require-auth";
import { validateOauthToken, getIssuer } from "@/lib/oauth";
import { registerCoreTools } from "../../../../mcp-server/register-core-tools";
import { registerV2Tools } from "../../../../mcp-server/tools-v2";
import { registerPgTools } from "../../../../mcp-server/register-tools-pg";

/**
 * Authenticate for MCP: OAuth token > API key > session cookie.
 */
async function authenticateMcp(request: NextRequest) {
  const authHeader = request.headers.get("authorization") ?? "";
  const urlToken = request.nextUrl.searchParams.get("token") ?? "";

  // 1. OAuth 2.1 access token (pf_oauth_...)
  const oauthCandidate = authHeader.startsWith("Bearer pf_oauth_") ? authHeader.slice(7) : null;
  if (oauthCandidate) {
    const result = await validateOauthToken(oauthCandidate);
    if (result) {
      return {
        authenticated: true as const,
        context: { userId: result.userId, method: "oauth" as const, mfaVerified: false },
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

  // 2 & 3. API key (pf_...) or X-API-Key header or ?token=
  const hasApiKey =
    request.headers.get("X-API-Key") ||
    authHeader.startsWith("Bearer pf_") ||
    urlToken.startsWith("pf_");

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

// POST — MCP messages (initialize + tool calls)
export async function POST(request: NextRequest) {
  const auth = await authenticateMcp(request);
  if (!auth.authenticated) return auth.response;

  const server = new McpServer({ name: "finlynq", version: "2.3.0" });

  if (getDialect() === "postgres") {
    // Cloud / managed mode — async Drizzle queries, user-scoped
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPgTools(server, db as any, auth.context.userId);
  } else {
    // Self-hosted mode — sync SQLite queries
    const sqlite = getConnection();
    registerCoreTools(server, sqlite);
    registerV2Tools(server, sqlite);
  }

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
