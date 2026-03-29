/**
 * TOTP-based Multi-Factor Authentication.
 *
 * Works in both self-hosted and managed editions.
 * Uses the `otpauth` library for RFC 6238 TOTP generation and verification.
 */

import { TOTP } from "otpauth";
import crypto from "crypto";

const ISSUER = "PersonalFinance";
const DIGITS = 6;
const PERIOD = 30; // seconds
const ALGORITHM = "SHA1";

/** Generate a new TOTP secret and return the provisioning URI for QR codes */
export function generateMfaSecret(email: string): {
  secret: string;
  uri: string;
} {
  const secretBytes = crypto.randomBytes(20);
  const secret = base32Encode(secretBytes);

  const totp = new TOTP({
    issuer: ISSUER,
    label: email,
    algorithm: ALGORITHM,
    digits: DIGITS,
    period: PERIOD,
    secret,
  });

  return {
    secret,
    uri: totp.toString(),
  };
}

/** Verify a TOTP code against a secret. Allows +/- 1 time window for clock skew. */
export function verifyMfaCode(secret: string, code: string): boolean {
  const totp = new TOTP({
    issuer: ISSUER,
    algorithm: ALGORITHM,
    digits: DIGITS,
    period: PERIOD,
    secret,
  });

  // delta = null means invalid, otherwise it's the time step difference
  const delta = totp.validate({ token: code, window: 1 });
  return delta !== null;
}

/** Generate backup codes (one-time use recovery codes) */
export function generateBackupCodes(count: number = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    // Format: XXXX-XXXX (8 hex chars with dash)
    const raw = crypto.randomBytes(4).toString("hex").toUpperCase();
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }
  return codes;
}

/** RFC 4648 base32 encoding (no padding) */
function base32Encode(buffer: Buffer): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += alphabet[(value << (5 - bits)) & 31];
  }

  return output;
}
