import { describe, it, expect } from "vitest";
import { deriveKey, generateSalt } from "@shared/crypto";

describe("crypto", () => {
  describe("generateSalt", () => {
    it("returns a 32-byte Buffer", () => {
      const salt = generateSalt();
      expect(Buffer.isBuffer(salt)).toBe(true);
      expect(salt.length).toBe(32);
    });

    it("produces unique salts on each call", () => {
      const s1 = generateSalt();
      const s2 = generateSalt();
      expect(s1.equals(s2)).toBe(false);
    });
  });

  describe("deriveKey", () => {
    it("returns a 64-char hex string (32 bytes)", () => {
      const salt = generateSalt();
      const key = deriveKey("test-passphrase", salt);
      expect(key).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is deterministic for the same passphrase and salt", () => {
      const salt = generateSalt();
      const k1 = deriveKey("my-password", salt);
      const k2 = deriveKey("my-password", salt);
      expect(k1).toBe(k2);
    });

    it("produces different keys for different passphrases", () => {
      const salt = generateSalt();
      const k1 = deriveKey("password-a", salt);
      const k2 = deriveKey("password-b", salt);
      expect(k1).not.toBe(k2);
    });

    it("produces different keys for different salts", () => {
      const s1 = generateSalt();
      const s2 = generateSalt();
      const k1 = deriveKey("same-pass", s1);
      const k2 = deriveKey("same-pass", s2);
      expect(k1).not.toBe(k2);
    });

    it("handles empty passphrase without throwing", () => {
      const salt = generateSalt();
      const key = deriveKey("", salt);
      expect(key).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
