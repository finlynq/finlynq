/**
 * Origin guard for /api/mcp (pure, testable).
 *
 * The allowlist is defense-in-depth for ONE thing: a browser page on another
 * site riding the user's Finlynq session cookie (cookie CSRF / DNS rebinding).
 * It must not block MCP clients that don't use the cookie at all.
 *
 * GH #424 follow-up (2026-11-20): the Gemini web app rejected
 * https://finlynq.com/api/mcp as "not a valid MCP server". Its connector sends
 * an Origin we don't list, and the old guard refused EVERY request with an
 * unlisted Origin with 403 before auth ran, so the unauthenticated probe never
 * got the 401 + WWW-Authenticate challenge that starts OAuth. A request with a
 * bearer token or API key, or one carrying no session cookie, can't ride a
 * session, so its Origin doesn't matter: it is authenticated (or refused) by
 * the token like any other client.
 */

export const MCP_ALLOWED_ORIGIN_HOSTS: ReadonlySet<string> = new Set([
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
  "gemini.google.com",
]);

/** True for no Origin, localhost, or a listed host. */
export function isAllowedMcpOrigin(origin: string | null): boolean {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return true;
    if (u.hostname.endsWith(".localhost")) return true;
    return MCP_ALLOWED_ORIGIN_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Refuse only a request from an unlisted Origin that would authenticate with
 * the browser session cookie: no bearer token, no API key, and the cookie
 * present.
 */
export function shouldRejectMcpOrigin(req: {
  origin: string | null;
  authorization: string | null;
  apiKey: string | null;
  hasSessionCookie: boolean;
}): boolean {
  if (isAllowedMcpOrigin(req.origin)) return false;
  if (/^Bearer\s+\S/i.test(req.authorization ?? "") || (req.apiKey ?? "") !== "") return false;
  return req.hasSessionCookie;
}
