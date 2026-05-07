import { describe, it, expect, beforeAll, beforeEach } from "vitest";

// Stable secret for deterministic HMAC output across the test run.
process.env.PF_JWT_SECRET = "test-jwt-secret-for-vitest-32chars!!";

import {
  signConfirmationToken,
  verifyConfirmationToken,
  CONFIRMATION_TOKEN_TTL_MS,
  __internals,
  __resetUsedJtiStoreForTests,
} from "@/lib/mcp/confirmation-token";

describe("confirmation-token", () => {
  const userId = "user-abc";
  const op = "bulk_delete";
  const payload = { ids: [1, 2, 3] };

  let token: string;
  beforeAll(() => {
    token = signConfirmationToken(userId, op, payload);
  });
  // M-2: clear the single-use store between tests so each test gets a clean
  // replay-protection slate. Tests in this file pre-date M-2 and check
  // mismatch reasons that are checked BEFORE the jti single-use marker — so
  // they don't burn the shared `token`'s jti — but a new token is signed in
  // some tests and we don't want any leftover state.
  beforeEach(() => {
    __resetUsedJtiStoreForTests();
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

  // ── M-2: single-use jti / replay protection ──────────────────────────────
  describe("M-2: single-use replay protection", () => {
    it("rejects the second use of the same token", () => {
      const tok = signConfirmationToken(userId, op, payload);
      const first = verifyConfirmationToken(tok, userId, op, payload);
      expect(first.valid).toBe(true);
      const second = verifyConfirmationToken(tok, userId, op, payload);
      expect(second.valid).toBe(false);
      expect(second.reason).toBe("replay");
    });

    it("does NOT consume the jti when verification fails for other reasons", () => {
      // A token that fails on user-mismatch should not have its jti marked
      // used — otherwise the legitimate caller would see "replay" instead of
      // "user-mismatch" on a retry. The legitimate verify still consumes the
      // jti, so the next legitimate attempt rejects as "replay".
      const tok = signConfirmationToken(userId, op, payload);
      const wrongUser = verifyConfirmationToken(tok, "evil", op, payload);
      expect(wrongUser.valid).toBe(false);
      expect(wrongUser.reason).toBe("user-mismatch");
      // Now legitimate user verifies — should succeed (jti was NOT burned).
      const ok = verifyConfirmationToken(tok, userId, op, payload);
      expect(ok.valid).toBe(true);
      // Second legitimate verify is replay.
      const replay = verifyConfirmationToken(tok, userId, op, payload);
      expect(replay.valid).toBe(false);
      expect(replay.reason).toBe("replay");
    });

    it("each freshly-signed token has a distinct jti", () => {
      const t1 = signConfirmationToken(userId, op, payload);
      const t2 = signConfirmationToken(userId, op, payload);
      // Same user/op/payload but distinct tokens — both verify independently.
      expect(verifyConfirmationToken(t1, userId, op, payload).valid).toBe(true);
      expect(verifyConfirmationToken(t2, userId, op, payload).valid).toBe(true);
      // Both replays rejected.
      expect(verifyConfirmationToken(t1, userId, op, payload).reason).toBe("replay");
      expect(verifyConfirmationToken(t2, userId, op, payload).reason).toBe("replay");
    });
  });
});
