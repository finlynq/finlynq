/**
 * Per-pending-jti rate limit on /api/auth/mfa/verify (H-4 regression).
 *
 * Five wrong codes per pending-jti exhausts the counter. The 6th attempt
 * is rejected with 429 even if the user supplies the correct code.
 *
 * The route file owns the in-process counter; we test it via the exported
 * `_clearVerifyAttempts` helper plus the route's POST handler.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

process.env.PF_JWT_SECRET = "test-jwt-secret-for-vitest-32chars!!";
process.env.DEPLOY_GENERATION = "0";

// Mock the rate-limit module so the per-IP gate doesn't fire first.
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(() => ({
    allowed: true,
    remaining: 99,
    resetAt: Date.now() + 60_000,
  })),
}));

// User lookup returns a user with MFA enabled but no encrypted secret —
// we never get past the 5 wrong codes, so we don't need a working DEK.
vi.mock("@/lib/auth/queries", () => ({
  getUserById: vi.fn(async (id: string) => ({
    id,
    mfaEnabled: 1,
    mfaSecret: "v1:dummy",
  })),
  recordSuccessfulLogin: vi.fn(async () => undefined),
}));

// Pending DEK is needed before the code-check branch — return a buffer so
// the route progresses to the verifyMfaCode call which we control.
const fakeDek = Buffer.alloc(32, 0x42);
vi.mock("@/lib/crypto/dek-cache", () => ({
  getDEK: vi.fn(() => fakeDek),
  putDEK: vi.fn(),
  deleteDEK: vi.fn(),
}));

// Decryption is irrelevant — we control verifyMfaCode below.
vi.mock("@/lib/crypto/envelope", () => ({
  decryptField: vi.fn(() => "decrypted-secret"),
}));

// Stub @/db so revokeJti's INSERT path doesn't hit Postgres. Returns no
// revoked rows so the auth chain accepts our fresh tokens.
vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [],
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => Promise.resolve(),
      }),
    }),
  },
}));
vi.mock("@/db/schema-pg", () => ({
  revokedJtis: { jti: "jti", expiresAt: "expires_at" },
}));

// Always fail MFA verification — exercises the wrong-code branch.
vi.mock("@/lib/auth/mfa", () => ({
  verifyMfaCode: vi.fn(() => false),
  generateMfaSecret: vi.fn(),
  generateBackupCodes: vi.fn(),
}));

// Side-effect imports we don't care about for this test.
vi.mock("@/lib/crypto/stream-d-canonicalize-portfolio", () => ({
  enqueueCanonicalizePortfolioNames: vi.fn(),
}));
vi.mock("@/lib/email-import/upgrade-staging-encryption", () => ({
  enqueueUpgradeStagingEncryption: vi.fn(),
}));

import { createSessionToken } from "@/lib/auth/jwt";
import { POST, _clearVerifyAttempts } from "@/app/api/auth/mfa/verify/route";

function makePost(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/auth/mfa/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/auth/mfa/verify — per-pending-jti attempt cap (H-4)", () => {
  beforeEach(() => {
    _clearVerifyAttempts();
    vi.clearAllMocks();
  });

  it("allows up to 5 wrong codes, rejects the 6th with 429", async () => {
    const { token } = await createSessionToken("u-rl-1", false, {
      pending: true,
      expirationTime: "5m",
    });

    // Five attempts return 401 (invalid code).
    for (let i = 0; i < 5; i++) {
      const res = await POST(
        makePost({ mfaPendingToken: token, code: "000000" })
      );
      expect(res.status).toBe(401);
    }

    // Sixth attempt: bucket exhausted, 429 regardless of code value.
    const sixth = await POST(
      makePost({ mfaPendingToken: token, code: "000000" })
    );
    expect(sixth.status).toBe(429);
  });

  it("rejects a non-pending token even on the right path", async () => {
    const { token } = await createSessionToken("u-rl-2", false);
    // No pending: true claim.
    const res = await POST(
      makePost({ mfaPendingToken: token, code: "000000" })
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid pending token/);
  });
});
