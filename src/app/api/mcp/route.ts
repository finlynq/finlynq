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
import { withAutoAnnotations } from "../../../../mcp-server/auto-annotations";

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
    const issuer = getIssuer();
    return {
      authenticated: false as const,
      response: NextResponse.json(
        { error: "invalid_token", error_description: "OAuth access token is invalid or expired" },
        { status: 401, headers: { "WWW-Authenticate": `Bearer realm="${issuer}", error="invalid_token"` } }
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
    version: "3.1.0",
    websiteUrl: "https://finlynq.com",
    description: "Track your money here, analyze it anywhere — open-source personal finance with 91 MCP tools.",
    icons: [
      { src: "https://finlynq.com/favicon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
    ],
  }));

  const scopeString = "scope" in auth.context ? auth.context.scope : DEFAULT_SCOPE;
  const scopeSet = parseScope(scopeString);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const originalTool = (server as any).tool.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).tool = (name: string, ...args: unknown[]) => {
    if (!isToolAllowedForScope(name, scopeSet)) {
      return undefined;
    }
    return originalTool(name, ...args);
  };

  const dek = "dek" in auth.context ? auth.context.dek : null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerPgTools(server, db as any, auth.context.userId, dek);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  return transport.handleRequest(request);
}

export async function GET(request: NextRequest) {
  if (!isAllowedOrigin(request.headers.get("origin"))) return rejectBadOrigin();
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

export async function DELETE() {
  return Response.json(
    { error: "Stateless mode — no sessions to delete." },
    { status: 405, headers: { Allow: "POST" } }
  );
}
