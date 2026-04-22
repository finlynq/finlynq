/**
 * JWT utilities for account-based authentication (managed edition).
 *
 * Uses the `jose` library which works in both Node.js and Edge runtimes.
 * Tokens are signed with HMAC-SHA256 using a server-side secret.
 */

import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import crypto from "crypto";

/** JWT claims for authenticated sessions */
export interface SessionPayload extends JWTPayload {
  sub: string; // user ID
  jti: string; // unique session ID (used as key for DEK cache)
  email: string;
  mfa: boolean; // whether MFA was verified
}

// Secret is generated once per process and persisted in memory.
// In production, PF_JWT_SECRET is required — refusing to boot with an
// ephemeral secret avoids the footgun of every session dying on restart.
// In dev, fall back to a random ephemeral secret with a one-time warning.
const getSecret = (() => {
  let secret: Uint8Array | null = null;
  let devWarned = false;
  return () => {
    if (!secret) {
      const envSecret = process.env.PF_JWT_SECRET;
      if (envSecret) {
        secret = new TextEncoder().encode(envSecret);
      } else {
        if (process.env.NODE_ENV === "production") {
          throw new Error(
            "PF_JWT_SECRET is required in production. Refusing to boot with an ephemeral secret — all sessions would die on restart."
          );
        }
        if (!devWarned) {
          devWarned = true;
          // eslint-disable-next-line no-console
          console.warn(
            "[auth] PF_JWT_SECRET not set — using ephemeral dev secret. Do not use in production."
          );
        }
        // Fallback: generate ephemeral secret (sessions won't survive restarts)
        secret = new TextEncoder().encode(
          crypto.randomBytes(32).toString("hex")
        );
      }
    }
    return secret;
  };
})();

const ISSUER = "pf-auth";
const AUDIENCE = "pf-app";
const EXPIRATION = "24h";
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Create a signed JWT for the given user session. Returns token + jti. */
export async function createSessionToken(
  userId: string,
  email: string,
  mfaVerified: boolean
): Promise<{ token: string; jti: string }> {
  const jti = crypto.randomUUID();
  const token = await new SignJWT({ email, mfa: mfaVerified })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setJti(jti)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(EXPIRATION)
    .sign(getSecret());
  return { token, jti };
}

/** Verify and decode a session JWT. Returns null if invalid. */
export async function verifySessionToken(
  token: string
): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    return payload as SessionPayload;
  } catch {
    return null;
  }
}
