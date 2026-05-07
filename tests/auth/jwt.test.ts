import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";

// Set a stable JWT secret for tests
process.env.PF_JWT_SECRET = "test-jwt-secret-for-vitest-32chars!!";

import {
  createSessionToken,
  verifySessionToken,
  verifySessionTokenDetailed,
  isPendingToken,
  _clearRevokedJtiCache,
} from "@/lib/auth/jwt";

describe("JWT utilities", () => {
  let token: string;
  let jti: string;

  beforeAll(async () => {
    ({ token, jti } = await createSessionToken("user-123", false));
  });

  it("creates a non-empty token string", () => {
    expect(token).toBeTruthy();
    expect(typeof token).toBe("string");
    // JWT has 3 dot-separated parts
    expect(token.split(".")).toHaveLength(3);
  });

  it("emits a non-empty jti for the DEK cache", () => {
    expect(jti).toBeTruthy();
    expect(typeof jti).toBe("string");
  });

  it("verifies a valid token and returns payload", async () => {
    const payload = await verifySessionToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe("user-123");
    expect(payload!.mfa).toBe(false);
    expect(payload!.jti).toBe(jti);
  });

  it("returns null for tampered tokens", async () => {
    const tampered = token.slice(0, -5) + "XXXXX";
    const payload = await verifySessionToken(tampered);
    expect(payload).toBeNull();
  });

  it("returns null for garbage input", async () => {
    const payload = await verifySessionToken("not-a-token");
    expect(payload).toBeNull();
  });

  it("includes MFA flag in token", async () => {
    const { token: mfaToken } = await createSessionToken("user-456", true);
    const payload = await verifySessionToken(mfaToken);
    expect(payload!.mfa).toBe(true);
  });
});

describe("JWT deploy-generation force-logout", () => {
  const originalGen = process.env.DEPLOY_GENERATION;
  afterEach(() => {
    if (originalGen === undefined) delete process.env.DEPLOY_GENERATION;
    else process.env.DEPLOY_GENERATION = originalGen;
  });

  it("accepts a token minted under the current deploy generation", async () => {
    process.env.DEPLOY_GENERATION = "deploy-1";
    const { token } = await createSessionToken("u", false);
    const res = await verifySessionTokenDetailed(token);
    expect(res.payload).not.toBeNull();
    expect(res.reason).toBeUndefined();
  });

  it("rejects a token minted under a previous deploy with deploy-reauth-required", async () => {
    process.env.DEPLOY_GENERATION = "deploy-1";
    const { token } = await createSessionToken("u", false);
    // Simulate a redeploy
    process.env.DEPLOY_GENERATION = "deploy-2";
    const res = await verifySessionTokenDetailed(token);
    expect(res.payload).toBeNull();
    expect(res.reason).toBe("deploy-reauth-required");
  });

  it("verifySessionToken returns null (back-compat) for cross-deploy tokens", async () => {
    process.env.DEPLOY_GENERATION = "deploy-a";
    const { token } = await createSessionToken("u", false);
    process.env.DEPLOY_GENERATION = "deploy-b";
    expect(await verifySessionToken(token)).toBeNull();
  });
});

describe("JWT pending claim (B7)", () => {
  it("default tokens have no pending claim", async () => {
    const { token } = await createSessionToken("user-pending-1", false);
    const payload = await verifySessionToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.pending).toBeUndefined();
    expect(isPendingToken(payload)).toBe(false);
  });

  it("pending: true is round-tripped through sign/verify", async () => {
    const { token } = await createSessionToken("user-pending-2", false, {
      pending: true,
      expirationTime: "5m",
    });
    const payload = await verifySessionToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.pending).toBe(true);
    expect(isPendingToken(payload)).toBe(true);
  });

  it("respects custom expirationTime overrides", async () => {
    const { token } = await createSessionToken("user-pending-3", false, {
      expirationTime: "5m",
    });
    const payload = await verifySessionToken(token);
    expect(payload).not.toBeNull();
    // 5 minutes from now ± a few seconds for sign/verify slop
    const expSec = payload!.exp as number;
    const now = Math.floor(Date.now() / 1000);
    expect(expSec - now).toBeGreaterThan(60 * 4);
    expect(expSec - now).toBeLessThan(60 * 6);
  });
});

describe("JWT revocation list (B7)", () => {
  // We mock the dynamic db import that isJtiRevoked reaches for so we can
  // exercise the cache + denylist logic without spinning up Postgres.
  beforeAll(() => {
    _clearRevokedJtiCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    _clearRevokedJtiCache();
  });

  it("verifySessionTokenDetailed returns reason='revoked' when jti is denylisted", async () => {
    const revokedSet = new Set<string>();
    // Stub the @/db and @/db/schema-pg modules with a minimal in-memory shim.
    vi.doMock("@/db", () => ({
      db: {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => {
                // We can't easily inspect the where() arg here, so we look
                // up via the captured jti-under-test instead. Reset per test.
                return Array.from(revokedSet).map((jti) => ({ jti }));
              },
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
    vi.doMock("@/db/schema-pg", () => ({
      revokedJtis: { jti: "jti", expiresAt: "expires_at" },
    }));
    vi.doMock("drizzle-orm", () => ({
      eq: (_col: unknown, val: unknown) => {
        // Side-effect: when the verifier asks "is jti X revoked?" we add it
        // to the set so the where().limit() shim returns a hit.
        revokedSet.add(val as string);
        return val;
      },
    }));

    // Re-import so the mocks take effect.
    vi.resetModules();
    const { createSessionToken: csTk, verifySessionTokenDetailed: vstd } =
      await import("@/lib/auth/jwt");
    process.env.DEPLOY_GENERATION = "0";
    const { token } = await csTk("user-revoked", false);
    const res = await vstd(token);
    expect(res.payload).toBeNull();
    expect(res.reason).toBe("revoked");
  });

  it("isPendingToken handles null safely", () => {
    expect(isPendingToken(null)).toBe(false);
  });
});
