import { describe, it, expect } from "vitest";
import {
  generateMfaSecret,
  verifyMfaCode,
  generateBackupCodes,
} from "@/lib/auth/mfa";
import { TOTP } from "otpauth";

describe("MFA (TOTP)", () => {
  describe("generateMfaSecret", () => {
    it("returns a secret and provisioning URI", () => {
      const result = generateMfaSecret("user@test.com");
      expect(result.secret).toBeTruthy();
      expect(result.uri).toContain("otpauth://totp/");
      expect(result.uri).toContain("user%40test.com");
      expect(result.uri).toContain("PersonalFinance");
    });

    it("generates unique secrets", () => {
      const s1 = generateMfaSecret("a@b.com");
      const s2 = generateMfaSecret("a@b.com");
      expect(s1.secret).not.toBe(s2.secret);
    });
  });

  describe("verifyMfaCode", () => {
    it("accepts a valid current code", () => {
      const { secret } = generateMfaSecret("test@test.com");
      const totp = new TOTP({
        secret,
        algorithm: "SHA1",
        digits: 6,
        period: 30,
      });
      const code = totp.generate();
      expect(verifyMfaCode(secret, code)).toBe(true);
    });

    it("rejects an invalid code", () => {
      const { secret } = generateMfaSecret("test@test.com");
      expect(verifyMfaCode(secret, "000000")).toBe(false);
    });
  });

  describe("generateBackupCodes", () => {
    it("generates the requested number of codes", () => {
      const codes = generateBackupCodes(8);
      expect(codes).toHaveLength(8);
    });

    it("formats codes as XXXX-XXXX", () => {
      const codes = generateBackupCodes(4);
      for (const code of codes) {
        expect(code).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
      }
    });

    it("generates unique codes", () => {
      const codes = generateBackupCodes(8);
      const unique = new Set(codes);
      expect(unique.size).toBe(8);
    });
  });
});
