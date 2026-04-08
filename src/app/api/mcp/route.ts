/**
 * Finlynq MCP Endpoint — Streamable HTTP transport (stateless mode)
 *
 * Stateless: each POST is fully self-contained — no session tracking needed.
 * enableJsonResponse: true — returns JSON (not SSE), required by Claude's
 * remote MCP connector and most other clients.
 *
 * Auth: accepts any of:
 *   Authorization: Bearer pf_<key>   ← Claude custom connector / Cursor
 *   Authorization: Bearer eyJ<jwt>   ← cloud session token
 *   X-API-Key: pf_<key>              ← direct API key header
 */

import { NextRequest } from "next/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getConnection } from "@/db";
import { requireAuth } from "@/lib/auth/require-auth";
import { registerCoreTools } from "../../../../mcp-server/register-core-tools";
import { registerV2Tools } from "../../../../mcp-server/tools-v2";
import { registerImportTemplateTools } from "../../../../mcp-server/tools-import-templates";

/** Create a fresh stateless MCP server + transport for one request */
function createHandler() {
  const sqlite = getConnection();
  const server = new McpServer({ name: "finlynq", version: "2.3.0" });
  registerCoreTools(server, sqlite);
  registerV2Tools(server, sqlite);
  registerImportTemplateTools(server, sqlite);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no session tracking
    enableJsonResponse: true,      // JSON responses, not SSE
  });

  return { server, transport };
}

// POST — MCP messages (initialize + tool calls)
export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  const { server, transport } = createHandler();
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
