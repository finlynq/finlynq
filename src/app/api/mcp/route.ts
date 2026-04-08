/**
 * Finlynq MCP Endpoint — Streamable HTTP transport (stateless mode)
 *
 * Stateless: each POST is fully self-contained — no session tracking needed.
 * enableJsonResponse: true — returns JSON (not SSE), required by Claude's
 * remote MCP connector and most other clients.
 *
 * Auth (checked in order):
 *   1. Authorization: Bearer pf_<key>   ← Claude custom connector / Cursor
 *   2. X-API-Key: pf_<key>              ← direct API key header
 *   3. ?token=pf_<key>                  ← URL query parameter
 *   4. Session cookie                   ← browser session (same as app routes)
 */

import { NextRequest } from "next/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getDialect, getConnection } from "@/db";
import { db } from "@/db";
import { requireAuth } from "@/lib/auth/require-auth";
import { accountStrategy } from "@/lib/auth/require-auth";
import { registerCoreTools } from "../../../../mcp-server/register-core-tools";
import { registerV2Tools } from "../../../../mcp-server/tools-v2";
import { registerPgTools } from "../../../../mcp-server/register-tools-pg";

/**
 * Authenticate with API key first; fall back to session cookie for browser access.
 */
async function authenticateMcp(request: NextRequest) {
  const auth = request.headers.get("authorization") ?? "";
  const hasApiKey =
    request.headers.get("X-API-Key") ||
    auth.startsWith("Bearer pf_") ||
    (request.nextUrl.searchParams.get("token") ?? "").startsWith("pf_");

  if (hasApiKey) {
    return requireAuth(request);
  }

  // No API key — try session cookie (browser / in-app use)
  const sessionResult = await accountStrategy.authenticate(request);
  if (sessionResult.authenticated) return sessionResult;

  // Fall back to normal requireAuth which will return the appropriate 401
  return requireAuth(request);
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

// GET — not used in stateless mode; return 405 with helpful message
export async function GET() {
  return Response.json(
    { error: "Finlynq MCP runs in stateless mode. Use POST requests only." },
    { status: 405, headers: { Allow: "POST" } }
  );
}

// DELETE — not used in stateless mode
export async function DELETE() {
  return Response.json(
    { error: "Stateless mode — no sessions to delete." },
    { status: 405, headers: { Allow: "POST" } }
  );
}
