import { describe, it, expect, beforeAll, afterEach } from "vitest";

// Set a stable JWT secret for tests
process.env.PF_JWT_SECRET = "test-jwt-secret-for-vitest-32chars!!";

import {
  createSessionToken,
  verifySessionToken,
  verifySessionTokenDetailed,
} from "@/lib/auth/jwt";

describe("JWT utilities", () => {
  let token: string;
  let jti: string;

  beforeAll(async () => {
    ({ token, jti } = await createSessionToken("user-123", "test@example.com", false));
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
    expect(payload!.email).toBe("test@example.com");
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
    const { token: mfaToken } = await createSessionToken("user-456", "mfa@test.com", true);
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
    const { token } = await createSessionToken("u", "e@e.com", false);
    const res = await verifySessionTokenDetailed(token);
    expect(res.payload).not.toBeNull();
    expect(res.reason).toBeUndefined();
  });

  it("rejects a token minted under a previous deploy with deploy-reauth-required", async () => {
    process.env.DEPLOY_GENERATION = "deploy-1";
    const { token } = await createSessionToken("u", "e@e.com", false);
    // Simulate a redeploy
    process.env.DEPLOY_GENERATION = "deploy-2";
    const res = await verifySessionTokenDetailed(token);
    expect(res.payload).toBeNull();
    expect(res.reason).toBe("deploy-reauth-required");
  });

  it("verifySessionToken returns null (back-compat) for cross-deploy tokens", async () => {
    process.env.DEPLOY_GENERATION = "deploy-a";
    const { token } = await createSessionToken("u", "e@e.com", false);
    process.env.DEPLOY_GENERATION = "deploy-b";
    expect(await verifySessionToken(token)).toBeNull();
  });
});
