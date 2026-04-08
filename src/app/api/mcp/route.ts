/**
 * Finlynq MCP Endpoint — Streamable HTTP transport (stateless mode)
 *
 * Stateless mode: each POST is fully self-contained (no session tracking).
 * enableJsonResponse: true — returns JSON rather than SSE, required by
 * Claude's remote MCP connector and most other clients.
 *
 * Auth: accepts either X-API-Key header or Authorization: Bearer <api-key>
 * (Claude's custom connector uses the Bearer form).
 */

import { NextRequest } from "next/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getConnection } from "@/db";
import { requireAuth } from "@/lib/auth/require-auth";
import { registerCoreTools } from "../../../../mcp-server/register-core-tools";
import { registerV2Tools } from "../../../../mcp-server/tools-v2";
import { registerImportTemplateTools } from "../../../../mcp-server/tools-import-templates";

/**
 * Normalize Authorization: Bearer <pf_...> → X-API-Key: <pf_...>
 * so the existing API key strategy can validate it.
 * JWTs start with "eyJ" and are left untouched (handled by AccountStrategy).
 */
function normalizeAuthHeader(request: NextRequest): NextRequest {
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Bearer ") && !auth.startsWith("Bearer eyJ")) {
    const key = auth.slice(7);
    const headers = new Headers(request.headers);
    headers.set("x-api-key", key);
    return new NextRequest(request.url, { method: request.method, headers, body: request.body });
  }
  return request;
}

/** Create a fresh stateless MCP server + transport for a single request */
function createStatelessHandler() {
  const sqlite = getConnection();
  const server = new McpServer({ name: "finlynq", version: "2.3.0" });
  registerCoreTools(server, sqlite);
  registerV2Tools(server, sqlite);
  registerImportTemplateTools(server, sqlite);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no session tracking
    enableJsonResponse: true,      // JSON responses instead of SSE streams
  });

  return { server, transport };
}

// POST — MCP messages (initialization + tool calls)
export async function POST(request: NextRequest) {
  const normalized = normalizeAuthHeader(request);
  const auth = await requireAuth(normalized);
  if (!auth.authenticated) return auth.response;

  const { server, transport } = createStatelessHandler();
  await server.connect(transport);
  return transport.handleRequest(normalized);
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
