/**
 * /api/auth/wipe-account hardening tests (H-7).
 *
 * - API-key auth is rejected with 403.
 * - With MFA enabled and no `mfaCode` in the body, the route returns 401
 *   `code: "mfa-required"`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

process.env.PF_JWT_SECRET = "test-jwt-secret-for-vitest-32chars!!";
process.env.DEPLOY_GENERATION = "0";

vi.mock("@/db", () => ({
  getDialect: () => "postgres",
  db: {},
}));

// Avoid hitting the real per-IP rate-limit map between tests.
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(() => ({
    allowed: true,
    remaining: 99,
    resetAt: Date.now() + 60_000,
  })),
}));

const apiKeyAuth = {
  authenticated: true,
  context: {
    userId: "u-api",
    method: "api_key" as const,
    mfaVerified: false,
    dek: null as Buffer | null,
    sessionId: null as string | null,
  },
};
const accountAuth = {
  authenticated: true,
  context: {
    userId: "u-account",
    method: "account" as const,
    mfaVerified: false,
    dek: Buffer.alloc(32, 0xab) as Buffer | null,
    sessionId: "sess-1" as string | null,
  },
};
let nextAuth: typeof apiKeyAuth | typeof accountAuth = accountAuth;

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => nextAuth),
}));

vi.mock("@/lib/auth/queries", () => ({
  getUserById: vi.fn(async (id: string) => ({
    id,
    passwordHash: "$2b$12$dummyhash",
    mfaEnabled: 1,
    mfaSecret: "v1:dummy",
  })),
  wipeUserDataAndRewrap: vi.fn(async () => undefined),
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    verifyPassword: vi.fn(async () => true),
    hashPassword: vi.fn(async () => "$2b$12$newhash"),
    verifyMfaCode: vi.fn(() => true),
  };
});

vi.mock("@/lib/crypto/envelope", () => ({
  createWrappedDEKForPassword: vi.fn(() => ({
    dek: Buffer.alloc(32),
    wrapped: {
      salt: Buffer.alloc(16),
      wrapped: Buffer.alloc(48),
      iv: Buffer.alloc(12),
      tag: Buffer.alloc(16),
    },
  })),
  decryptField: vi.fn(() => "decrypted-secret"),
}));

vi.mock("@/lib/crypto/dek-cache", () => ({
  getDEK: vi.fn(() => Buffer.alloc(32, 0xab)),
  evictAllForUser: vi.fn(),
}));

vi.mock("@/lib/mcp/user-tx-cache", () => ({
  invalidateUser: vi.fn(),
}));

import { POST } from "@/app/api/auth/wipe-account/route";

function makePost(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/auth/wipe-account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/wipe-account — H-7 hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects API-key authenticated requests with 403", async () => {
    nextAuth = apiKeyAuth;
    const res = await POST(makePost({ password: "pw", confirmation: "WIPE" }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/API keys are not allowed/);
  });

  it("rejects account requests without mfaCode when user has MFA enabled", async () => {
    nextAuth = accountAuth;
    const res = await POST(makePost({ password: "pw", confirmation: "WIPE" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("mfa-required");
  });

  it("accepts account requests with a valid mfaCode and MFA enabled", async () => {
    nextAuth = accountAuth;
    const res = await POST(
      makePost({ password: "pw", confirmation: "WIPE", mfaCode: "123456" })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});
