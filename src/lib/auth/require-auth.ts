/**
 * requireAuth() — unified authentication middleware.
 *
 * Delegates to the active auth strategy based on the current product mode:
 *  - Self-hosted (SQLite): passphrase strategy (DB must be unlocked)
 *  - Managed (PostgreSQL): account strategy (JWT session required)
 *  - Either: API key strategy (X-API-Key header)
 *
 * Usage in route handlers:
 *   const auth = await requireAuth(request);
 *   if (!auth.authenticated) return auth.response;
 *   const { userId } = auth.context;
 */

import { NextRequest } from "next/server";
import { getDialect } from "@/db";
import { PassphraseStrategy } from "./strategies/passphrase";
import { AccountStrategy } from "./strategies/account";
import { ApiKeyStrategy } from "./strategies/api-key";
import type { AuthResult, AuthStrategy } from "./strategy";

// Singleton strategy instances
const passphraseStrategy = new PassphraseStrategy();
const accountStrategy = new AccountStrategy();
const apiKeyStrategy = new ApiKeyStrategy();

/**
 * Authenticate an incoming request using the appropriate strategy.
 *
 * Strategy selection:
 * 1. If X-API-Key header is present, use API key strategy
 * 2. Otherwise, delegate to the product-specific strategy:
 *    - sqlite dialect → passphrase strategy
 *    - postgres dialect → account strategy
 */
export async function requireAuth(request: NextRequest): Promise<AuthResult> {
  const strategy = selectStrategy(request);
  return strategy.authenticate(request);
}

/** Select the appropriate strategy based on request headers and dialect */
function selectStrategy(request: NextRequest): AuthStrategy {
  // API key: explicit X-API-Key header, Bearer pf_ token, or ?token=pf_ query param
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

  // Dialect-based strategy
  const dialect = getDialect();
  if (dialect === "postgres") {
    return accountStrategy;
  }

  return passphraseStrategy;
}

export { passphraseStrategy, accountStrategy, apiKeyStrategy };
