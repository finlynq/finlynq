/**
 * Password Reset Flow — managed edition only.
 *
 * Generates time-limited tokens for email-based password recovery.
 * Tokens are stored as SHA-256 hashes so they can't be extracted from the DB.
 */

import crypto from "crypto";

const TOKEN_EXPIRY_HOURS = 1;

/** Generate a password reset token and its hash for storage */
export function generateResetToken(): {
  token: string;
  tokenHash: string;
  expiresAt: string;
} {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(
    Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000
  ).toISOString();

  return { token, tokenHash, expiresAt };
}

/** Hash a token for lookup comparison */
export function hashResetToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Check if a token expiry timestamp has passed */
export function isTokenExpired(expiresAt: string): boolean {
  return new Date(expiresAt).getTime() < Date.now();
}
