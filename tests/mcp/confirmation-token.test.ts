import { describe, it, expect, beforeAll } from "vitest";

// Stable secret for deterministic HMAC output across the test run.
process.env.PF_JWT_SECRET = "test-jwt-secret-for-vitest-32chars!!";

import {
  signConfirmationToken,
  verifyConfirmationToken,
  CONFIRMATION_TOKEN_TTL_MS,
  __internals,
} from "@/lib/mcp/confirmation-token";

describe("confirmation-token", () => {
  const userId = "user-abc";
  const op = "bulk_delete";
  const payload = { ids: [1, 2, 3] };

  let token: string;
  beforeAll(() => {
    token = signConfirmationToken(userId, op, payload);
  });

  it("produces a two-part base64url token", () => {
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(token.split(".")).toHaveLength(2);
  });

  it("verifies a freshly-signed token against the same scope", () => {
    const res = verifyConfirmationToken(token, userId, op, payload);
    expect(res.valid).toBe(true);
    expect(res.claims?.userId).toBe(userId);
    expect(res.claims?.operation).toBe(op);
    expect(res.claims?.expiresAt).toBeGreaterThan(Date.now());
    expect(res.claims?.expiresAt).toBeLessThanOrEqual(
      Date.now() + CONFIRMATION_TOKEN_TTL_MS + 1000
    );
  });

  it("rejects when userId differs", () => {
    const res = verifyConfirmationToken(token, "someone-else", op, payload);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("user-mismatch");
  });

  it("rejects when operation differs", () => {
    const res = verifyConfirmationToken(token, userId, "bulk_update", payload);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("operation-mismatch");
  });

  it("rejects when payload differs (replay-on-different-rows attack)", () => {
    const res = verifyConfirmationToken(token, userId, op, { ids: [4, 5, 6] });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("payload-mismatch");
  });

  it("accepts when payload has the same keys in different order (canonical JSON)", () => {
    const reordered = { b: 2, a: 1 };
    const original = { a: 1, b: 2 };
    const tok = signConfirmationToken(userId, op, original);
    const res = verifyConfirmationToken(tok, userId, op, reordered);
    expect(res.valid).toBe(true);
  });

  it("rejects malformed tokens", () => {
    const res = verifyConfirmationToken("not-a-token", userId, op, payload);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("malformed");
  });

  it("rejects tampered signatures", () => {
    const [p] = token.split(".");
    const forged = `${p}.${"A".repeat(43)}`;
    const res = verifyConfirmationToken(forged, userId, op, payload);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("bad-signature");
  });

  it("produces deterministic payload hashes across equivalent shapes", () => {
    expect(__internals.hashPayload({ a: 1, b: [1, 2] })).toBe(
      __internals.hashPayload({ b: [1, 2], a: 1 })
    );
    expect(__internals.hashPayload({ a: 1 })).not.toBe(
      __internals.hashPayload({ a: 2 })
    );
  });
});
