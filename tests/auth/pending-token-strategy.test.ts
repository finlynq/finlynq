/**
 * Pending-token gate test — H-4 regression.
 *
 * Asserts that the AccountStrategy:
 *   - Accepts a pending token only on /api/auth/mfa/verify
 *   - Rejects pending tokens on every other route (401, code: "mfa-pending")
 *   - Accepts a non-pending token everywhere
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

// Set a stable JWT secret so signing/verifying works in-process.
process.env.PF_JWT_SECRET = "test-jwt-secret-for-vitest-32chars!!";
process.env.DEPLOY_GENERATION = "0";

// The strategy reads the DEK cache after auth — neutralise it.
vi.mock("@/lib/crypto/dek-cache", () => ({
  getDEK: vi.fn(() => null),
}));

// Stub out the @/db dynamic import that isJtiRevoked uses, so the test
// doesn't require Postgres. No jtis are revoked.
vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [],
        }),
      }),
    }),
  },
}));
vi.mock("@/db/schema-pg", () => ({
  revokedJtis: { jti: "jti", expiresAt: "expires_at" },
}));

import { createSessionToken } from "@/lib/auth/jwt";
import { AccountStrategy } from "@/lib/auth/strategies/account";

function makeRequest(pathname: string, cookieToken: string): NextRequest {
  return new NextRequest(`http://localhost:3000${pathname}`, {
    headers: { cookie: `pf_session=${cookieToken}` },
  });
}

describe("AccountStrategy — pending-token gate (H-4)", () => {
  let pendingToken: string;
  let fullToken: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ token: pendingToken } = await createSessionToken("u-pending", false, {
      pending: true,
      expirationTime: "5m",
    }));
    ({ token: fullToken } = await createSessionToken("u-full", true));
  });

  it("rejects a pending token on /api/dashboard with code mfa-pending", async () => {
    const strategy = new AccountStrategy();
    const result = await strategy.authenticate(
      makeRequest("/api/dashboard", pendingToken)
    );
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.response.status).toBe(401);
      const body = await result.response.json();
      expect(body.code).toBe("mfa-pending");
    }
  });

  it("rejects a pending token on /api/transactions", async () => {
    const strategy = new AccountStrategy();
    const result = await strategy.authenticate(
      makeRequest("/api/transactions", pendingToken)
    );
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.response.status).toBe(401);
    }
  });

  it("accepts a pending token on /api/auth/mfa/verify", async () => {
    const strategy = new AccountStrategy();
    const result = await strategy.authenticate(
      makeRequest("/api/auth/mfa/verify", pendingToken)
    );
    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.context.userId).toBe("u-pending");
    }
  });

  it("accepts a full session everywhere", async () => {
    const strategy = new AccountStrategy();
    const dash = await strategy.authenticate(
      makeRequest("/api/dashboard", fullToken)
    );
    expect(dash.authenticated).toBe(true);
    const verify = await strategy.authenticate(
      makeRequest("/api/auth/mfa/verify", fullToken)
    );
    expect(verify.authenticated).toBe(true);
  });
});
