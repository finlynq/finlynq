/**
 * requireAuth() — unified authentication middleware (PostgreSQL-only mode).
 *
 * Strategies:
 *  - API key (X-API-Key header, Bearer pf_ token, or ?token=pf_ query param)
 *  - Account session (JWT cookie) — the default
 *
 * Usage in route handlers:
 *   const auth = await requireAuth(request);
 *   if (!auth.authenticated) return auth.response;
 *   const { userId } = auth.context;
 */

import { NextRequest } from "next/server";
import { AccountStrategy } from "./strategies/account";
import { ApiKeyStrategy } from "./strategies/api-key";
import { bumpLastActive } from "./last-active";
import type { AuthResult, AuthStrategy } from "./strategy";

// Singleton strategy instances
const accountStrategy = new AccountStrategy();
const apiKeyStrategy = new ApiKeyStrategy();

/**
 * Authenticate an incoming request using the appropriate strategy.
 *
 * Strategy selection:
 * 1. If the request carries an API-key credential, use the API key strategy.
 * 2. Otherwise, use the account (JWT cookie) strategy.
 */
export async function requireAuth(request: NextRequest): Promise<AuthResult> {
  const result = await selectStrategy(request).authenticate(request);
  // FINLYNQ-166 — advance last_active_at on any successful authed access (web
  // session + pf_ API-key both funnel through here). DB-side-throttled +
  // fire-and-forget so it never blocks or fails the request.
  if (result.authenticated) {
    void bumpLastActive(result.context.userId);
  }
  return result;
}

function selectStrategy(request: NextRequest): AuthStrategy {
  const auth = request.headers.get("authorization") ?? "";
  let urlToken: string | null = null;
  try { urlToken = request.nextUrl.searchParams.get("token"); } catch { /* ignore */ }
  if (
    request.headers.get("X-API-Key") ||
    auth.startsWith("Bearer pf_") ||
    (urlToken?.startsWith("pf_") ?? false)
  ) {
    return apiKeyStrategy;
  }
  return accountStrategy;
}

export { accountStrategy, apiKeyStrategy };
