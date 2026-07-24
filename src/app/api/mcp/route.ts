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
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { db } from "@/db";
import { requireAuth } from "@/lib/auth/require-auth";
import { accountStrategy } from "@/lib/auth/require-auth";
import { validateOauthToken, bearerChallenge } from "@/lib/oauth";
import { DEFAULT_SCOPE, parseScope, isToolAllowedForScope, enabledToolsetsForRequest } from "@/lib/oauth-scopes";
import { checkRateLimit } from "@/lib/rate-limit";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { registerPgTools } from "../../../../mcp-server/register-tools-pg";
import { withAutoAnnotations } from "../../../../mcp-server/auto-annotations";
import { buildFilteredToolsList } from "../../../../mcp-server/tools/_consolidate";
import { MCP_TOOL_COUNTS, MCP_SERVER_VERSION, MCP_SERVER_INSTRUCTIONS } from "@/lib/mcp/tool-counts";
import { isToolInEnabledToolsets } from "@/lib/mcp/toolsets";

// Origin allowlist - defense-in-depth against DNS rebinding and cross-site
// cookie attacks against the session-cookie auth path. Bearer-token requests
// typically don't send Origin, so a missing Origin is allowed - auth still
// has to pass.
const ALLOWED_ORIGIN_HOSTS = new Set([
  "finlynq.com",
  "www.finlynq.com",
  "demo.finlynq.com",
  "dev.finlynq.com",
  "claude.ai",
  "www.claude.ai",
  "claude.com",
  "www.claude.com",
  "chat.openai.com",
  "chatgpt.com",
  "cursor.com",
  "windsurf.dev",
  "codeium.com",
]);

/**
 * Narrow view of an `McpServer` whose `tool(...)` / `registerTool(...)` methods
 * are writable, so the per-request OAuth-scope filter can wrap BOTH (FINLYNQ-114
 * — replaces the old untyped monkey-patch; the reconcile-consolidation D-1 fix
 * extends the gate to `registerTool`, which the consolidated `manage_*`/
 * `reconcile` union tools register through). The wrapped methods return
 * `undefined` for out-of-scope tools (the SDK callers in `registerPgTools` +
 * `registerManageTool` ignore the return value, so a no-op registration is
 * safe). Both are read-only overloaded methods in the SDK types, so we cast
 * through this single, named interface at the patch site instead of an untyped
 * escape.
 */
interface ScopeFilterableServer {
  tool(name: string, ...args: unknown[]): RegisteredTool | undefined;
  registerTool(name: string, ...args: unknown[]): RegisteredTool | undefined;
}

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return true;
    if (u.hostname.endsWith(".localhost")) return true;
    return ALLOWED_ORIGIN_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

function rejectBadOrigin(): NextResponse {
  return NextResponse.json(
    { error: "forbidden_origin", error_description: "Origin not allowed" },
    { status: 403 }
  );
}

async function authenticateMcp(request: NextRequest) {
  const authHeader = request.headers.get("authorization") ?? "";

  const oauthCandidate = authHeader.startsWith("Bearer pf_oauth_") ? authHeader.slice(7) : null;
  if (oauthCandidate) {
    const result = await validateOauthToken(oauthCandidate);
    if (result) {
      return {
        authenticated: true as const,
        context: { userId: result.userId, method: "oauth" as const, mfaVerified: false, dek: result.dek, sessionId: null as string | null, scope: result.scope },
      };
    }
    return {
      authenticated: false as const,
      response: NextResponse.json(
        { error: "invalid_token", error_description: "OAuth access token is invalid or expired" },
        { status: 401, headers: { "WWW-Authenticate": bearerChallenge({ error: "invalid_token" }) } }
      ),
    };
  }

  const hasApiKey =
    request.headers.get("X-API-Key") ||
    authHeader.startsWith("Bearer pf_");

  if (hasApiKey) {
    return requireAuth(request);
  }

  const sessionResult = await accountStrategy.authenticate(request);
  if (sessionResult.authenticated) return sessionResult;

  return {
    authenticated: false as const,
    response: NextResponse.json(
      { error: "unauthorized", error_description: "Authentication required" },
      { status: 401, headers: { "WWW-Authenticate": bearerChallenge() } }
    ),
  };
}

const MCP_MAX_BODY_BYTES = 1 * 1024 * 1024;

export async function POST(request: NextRequest) {
  if (!isAllowedOrigin(request.headers.get("origin"))) return rejectBadOrigin();

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

  const rl = checkRateLimit(`mcp:${auth.context.userId}`, 60, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded for MCP endpoint" },
      { status: 429, headers: { "Retry-After": String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } }
    );
  }

  // Apply auto-annotations FIRST so every tool gets title + readOnlyHint /
  // destructiveHint / idempotentHint / openWorldHint inferred from name.
  // The scope filter below then wraps that further; both patches compose.
  const server = withAutoAnnotations(new McpServer({
    name: "finlynq",
    title: "Finlynq",
    version: MCP_SERVER_VERSION,
    websiteUrl: "https://finlynq.com",
    description: `Track your money here, analyze it anywhere. Open-source personal finance TRACKER with ${MCP_TOOL_COUNTS.http} MCP tools. Bookkeeping only: tools read and write entries in your own database and never connect to a bank or brokerage or move real money.`,
    icons: [
      { src: "https://finlynq.com/favicon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
    ],
  }, {
    // FINLYNQ-266 — the bookkeeping-only trust posture is sent ONCE per session
    // here instead of opening every write-tool description.
    instructions: MCP_SERVER_INSTRUCTIONS,
  }));

  const scopeString = "scope" in auth.context ? auth.context.scope : DEFAULT_SCOPE;
  const scopeSet = parseScope(scopeString);

  // Resolve the session toolsets. Every connection gets the same default profile
  // now (analytics + ledger-write) — the import/reconcile cohort was folded into
  // default-ON union tools (reconcile-consolidation), so there is no opt-in set.
  // An out-of-toolset tool is NEVER registered → neither listed NOR callable.
  const enabledSets = enabledToolsetsForRequest(scopeSet);

  // The SDK types `tool` / `registerTool` as read-only overloaded methods, so
  // reach them through a single named interface (ScopeFilterableServer) rather
  // than `any`. The wrap composes the OAuth scope gate (read/write) with the
  // toolset gate. D-1: BOTH registration paths are gated — legacy `server.tool`
  // tools AND the consolidated `manage_*` / `reconcile` union tools (which
  // register via `server.registerTool`). Without the registerTool patch a
  // read-only token would get every union write tool registered + callable.
  const scopable = server as unknown as ScopeFilterableServer;
  const gate = (name: string): boolean =>
    isToolAllowedForScope(name, scopeSet) && isToolInEnabledToolsets(name, enabledSets);
  const originalTool = scopable.tool.bind(server);
  scopable.tool = (name: string, ...args: unknown[]) => {
    if (!gate(name)) return undefined;
    return originalTool(name, ...args);
  };
  const originalRegisterTool = scopable.registerTool.bind(server);
  scopable.registerTool = (name: string, ...args: unknown[]) => {
    if (!gate(name)) return undefined;
    return originalRegisterTool(name, ...args);
  };

  const dek = "dek" in auth.context ? auth.context.dek : null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerPgTools(server, db as any, auth.context.userId, dek);

  // Post-process `tools/list`: hide back-compat aliases (callable but not
  // advertised) + substitute the pre-computed `oneOf` JSON schema for
  // consolidated tools (the SDK renders a union input as an empty object).
  // Out-of-scope / out-of-toolset tools are already unregistered above, so this
  // predicate (D-1: scope AND toolset) is a belt-and-braces pass.
  const toolFilter = (name: string) => gate(name);
  {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner = server.server as any;
    // The SDK registered its ListTools handler when the first tool was added;
    // wrap it so we post-process the rendered list.
    const originalListHandler = inner._requestHandlers.get(
      ListToolsRequestSchema.shape.method.value,
    ) as ((req: unknown, extra: unknown) => Promise<{ tools: unknown[] }>) | undefined;
    if (originalListHandler) {
      inner._requestHandlers.set(
        ListToolsRequestSchema.shape.method.value,
        async (req: unknown, extra: unknown) => {
          const rendered = await originalListHandler(req, extra);
          return {
            ...rendered,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            tools: buildFilteredToolsList(rendered.tools as any, toolFilter),
          };
        },
      );
    }
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  return transport.handleRequest(request);
}

/**
 * GH #318 (bug 4, the fatal one) — this endpoint runs the Streamable HTTP
 * transport in STATELESS mode (`sessionIdGenerator: undefined`,
 * `enableJsonResponse: true`), so there is no server-initiated SSE stream to
 * open here. The MCP Streamable HTTP spec says a server that does not offer an
 * SSE stream at its endpoint MUST answer the GET with 405 Method Not Allowed.
 *
 * This used to return 401 UNCONDITIONALLY — it never even read the
 * Authorization header. `StreamableHTTPClientTransport._startOrAuthSse` opens
 * this GET before any POST, read the 401 as "credentials rejected", and ran a
 * full re-auth; the re-auth succeeded, issued a token, and hit the same
 * blanket 401 again — an infinite loop that never reached the POST that would
 * have worked. It also explains why `oauth_access_tokens.last_used_at` stayed
 * NULL across the storm: this path never calls `validateOauthToken` at all.
 * A real prod user minted 133 tokens in 26 minutes this way (2026-07-23).
 *
 * 405 tells the SDK "no SSE here, use POST" and it proceeds normally. Do NOT
 * reintroduce a WWW-Authenticate header: this is not an auth failure, and
 * advertising one re-arms the same re-auth reflex. Mirrors DELETE below.
 */
export async function GET(request: NextRequest) {
  if (!isAllowedOrigin(request.headers.get("origin"))) return rejectBadOrigin();
  return NextResponse.json(
    { error: "Stateless mode — no SSE stream. Use POST with a valid Bearer token." },
    { status: 405, headers: { Allow: "POST" } }
  );
}

export async function DELETE() {
  return Response.json(
    { error: "Stateless mode — no sessions to delete." },
    { status: 405, headers: { Allow: "POST" } }
  );
}
