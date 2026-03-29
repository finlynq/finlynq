import { NextRequest } from "next/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getConnection } from "@/db";
import { requireAuth } from "@/lib/auth/require-auth";
import { registerCoreTools } from "../../../../mcp-server/register-core-tools";
import { registerV2Tools } from "../../../../mcp-server/tools-v2";

// Session map for stateful MCP connections
const g = globalThis as typeof globalThis & {
  __mcpSessions?: Map<string, { server: McpServer; transport: WebStandardStreamableHTTPServerTransport }>;
};
function getSessions() {
  if (!g.__mcpSessions) g.__mcpSessions = new Map();
  return g.__mcpSessions;
}

function createSession(): { server: McpServer; transport: WebStandardStreamableHTTPServerTransport } {
  const sqlite = getConnection();

  const server = new McpServer({
    name: "pf-finance",
    version: "2.3.0",
  });
  registerCoreTools(server, sqlite);
  registerV2Tools(server, sqlite);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (sessionId) => {
      getSessions().set(sessionId, { server, transport });
    },
    onsessionclosed: (sessionId) => {
      getSessions().delete(sessionId);
    },
  });

  server.connect(transport);
  return { server, transport };
}

function getSessionByRequest(request: Request): { server: McpServer; transport: WebStandardStreamableHTTPServerTransport } | undefined {
  const sessionId = request.headers.get("mcp-session-id");
  if (sessionId) return getSessions().get(sessionId);
  return undefined;
}

// POST — MCP messages (initialization + tool calls)
export async function POST(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;

  // Existing session or new one (initialization)
  const existing = getSessionByRequest(request);
  const { transport } = existing ?? createSession();
  return transport.handleRequest(request);
}

// GET — SSE stream for server-initiated messages
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;

  const existing = getSessionByRequest(request);
  if (!existing) {
    return Response.json(
      { error: "No active session. Send an initialization POST first." },
      { status: 400 }
    );
  }
  return existing.transport.handleRequest(request);
}

// DELETE — close MCP session
export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;

  const existing = getSessionByRequest(request);
  if (!existing) {
    return Response.json({ error: "Session not found." }, { status: 404 });
  }
  return existing.transport.handleRequest(request);
}
