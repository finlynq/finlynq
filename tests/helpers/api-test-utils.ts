import { vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Default test DEK — 32 bytes of 0xAA. Routes that call `requireEncryption()`
 * pull `dek` + `sessionId` out of the `requireAuth()` AuthContext; if either
 * is null the route returns 423 Locked.
 *
 * Use {@link mockAuthContext} to mint an AuthContext-shaped object for inline
 * `vi.mock("@/lib/auth/require-auth", ...)` stubs in API route tests.
 */
export const TEST_DEK = Buffer.alloc(32, 0xaa);
export const TEST_SESSION_ID = "test-session-jti";

/**
 * Build a fully-populated AuthContext for use in `requireAuth` mocks. Includes
 * a non-null `dek` + `sessionId` so routes wrapped in `requireEncryption()` do
 * not return 423 under test. Spread `...overrides` to customize `userId` etc.
 */
export function mockAuthContext(overrides?: {
  userId?: string;
  method?: "passphrase" | "account" | "api_key" | "oauth";
  mfaVerified?: boolean;
  dek?: Buffer | null;
  sessionId?: string | null;
}) {
  return {
    userId: overrides?.userId ?? "default",
    method: overrides?.method ?? ("passphrase" as const),
    mfaVerified: overrides?.mfaVerified ?? false,
    dek: overrides?.dek === undefined ? TEST_DEK : overrides.dek,
    sessionId: overrides?.sessionId === undefined ? TEST_SESSION_ID : overrides.sessionId,
  };
}

/**
 * Create a mock NextRequest for API route testing.
 */
export function createMockRequest(
  url: string,
  options?: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  }
): NextRequest {
  const init: RequestInit = {
    method: options?.method ?? "GET",
    headers: options?.headers ?? {},
  };
  if (options?.body) {
    init.body = JSON.stringify(options.body);
    init.headers = { ...init.headers as Record<string, string>, "Content-Type": "application/json" };
  }
  return new NextRequest(new URL(url, "http://localhost:3000"), init as never);
}

/**
 * Extract JSON from NextResponse.
 */
export async function parseResponse(response: Response): Promise<{ status: number; data: unknown }> {
  const data = await response.json();
  return { status: response.status, data };
}

/**
 * Create a chainable mock for Drizzle ORM query builder.
 * Supports: select().from().where().orderBy().groupBy().leftJoin().limit().offset().all().get().run()
 *
 * The chain is also a thenable: `await chain` resolves to the configured
 * `returnValue` array. Real Drizzle SELECT chains are thenables — route code
 * frequently calls `const rows = await db.select()...where(...)` without a
 * trailing `.all()`. Without `then`, `await chain` returns the chain object
 * itself and `rows.map/length` blows up.
 */
export function createDrizzleMock(returnValue: unknown = []) {
  const rows = Array.isArray(returnValue) ? returnValue : [];
  const chain: Record<string, unknown> = {};
  const methods = ["select", "from", "where", "orderBy", "groupBy", "leftJoin", "limit", "offset", "values", "set", "returning"];
  for (const method of methods) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain.all = vi.fn().mockReturnValue(rows);
  chain.get = vi.fn().mockReturnValue(Array.isArray(returnValue) ? returnValue[0] : returnValue);
  chain.run = vi.fn().mockReturnValue(undefined);

  // insert/update/delete return the chain too
  chain.insert = vi.fn().mockReturnValue(chain);
  chain.update = vi.fn().mockReturnValue(chain);
  chain.delete = vi.fn().mockReturnValue(chain);

  // Thenable shim: awaiting the chain resolves to the rows array, matching the
  // shape real Drizzle SELECTs produce when awaited without a terminator.
  chain.then = (resolve: (v: unknown) => unknown) => resolve(rows);

  return chain;
}
