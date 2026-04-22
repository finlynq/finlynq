import { describe, it, expect, beforeAll } from "vitest";

// Set a stable JWT secret for tests
process.env.PF_JWT_SECRET = "test-jwt-secret-for-vitest-32chars!!";

import { createSessionToken, verifySessionToken } from "@/lib/auth/jwt";

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
