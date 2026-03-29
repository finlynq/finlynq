import { describe, it, expect } from "vitest";
import {
  generateResetToken,
  hashResetToken,
  isTokenExpired,
} from "@/lib/auth/password-reset";

describe("Password reset utilities", () => {
  describe("generateResetToken", () => {
    it("returns a token, hash, and expiry", () => {
      const result = generateResetToken();
      expect(result.token).toBeTruthy();
      expect(result.tokenHash).toBeTruthy();
      expect(result.expiresAt).toBeTruthy();
      // Token is hex
      expect(result.token).toMatch(/^[0-9a-f]{64}$/);
      // Hash is different from raw token
      expect(result.tokenHash).not.toBe(result.token);
    });

    it("generates unique tokens", () => {
      const t1 = generateResetToken();
      const t2 = generateResetToken();
      expect(t1.token).not.toBe(t2.token);
    });

    it("expiry is in the future", () => {
      const result = generateResetToken();
      expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe("hashResetToken", () => {
    it("produces a deterministic hash", () => {
      const token = "abc123";
      const h1 = hashResetToken(token);
      const h2 = hashResetToken(token);
      expect(h1).toBe(h2);
    });

    it("matches the hash from generateResetToken", () => {
      const { token, tokenHash } = generateResetToken();
      expect(hashResetToken(token)).toBe(tokenHash);
    });
  });

  describe("isTokenExpired", () => {
    it("returns false for future timestamps", () => {
      const future = new Date(Date.now() + 3600_000).toISOString();
      expect(isTokenExpired(future)).toBe(false);
    });

    it("returns true for past timestamps", () => {
      const past = new Date(Date.now() - 1000).toISOString();
      expect(isTokenExpired(past)).toBe(true);
    });
  });
});
