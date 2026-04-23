/**
 * JWT utilities for account-based authentication (managed edition).
 *
 * Uses the `jose` library which works in both Node.js and Edge runtimes.
 * Tokens are signed with HMAC-SHA256 using a server-side secret.
 *
 * Deploy-generation force-logout:
 *   `DEPLOY_GENERATION` must be set in the process environment on every
 *   deploy (deploy.sh exports `DEPLOY_GENERATION=$(date +%s)` before the
 *   systemd restart). It becomes the `gen` claim on every newly-issued
 *   token; verification rejects tokens with a mismatched `gen`. When that
 *   happens the verifier returns reason `"deploy-reauth-required"`, which
 *   the auth middleware surfaces to clients as a 401 with
 *   `{ code: "deploy-reauth-required" }` so the UI can show a "please
 *   sign in again" screen instead of a generic error. If `DEPLOY_GENERATION`
 *   is unset we default to "0" so local dev keeps working.
 */

import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import crypto from "crypto";

/** JWT claims for authenticated sessions */
export interface SessionPayload extends JWTPayload {
  sub: string; // user ID
  jti: string; // unique session ID (used as key for DEK cache)
  email: string;
  mfa: boolean; // whether MFA was verified
  gen?: string; // deploy-generation stamp; rejected if it doesn't match current env
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

/** Resolve the current deploy-generation. Read each call so tests can mutate env. */
export function currentDeployGeneration(): string {
  return process.env.DEPLOY_GENERATION ?? "0";
}

/** Create a signed JWT for the given user session. Returns token + jti. */
export async function createSessionToken(
  userId: string,
  email: string,
  mfaVerified: boolean
): Promise<{ token: string; jti: string }> {
  const jti = crypto.randomUUID();
  const token = await new SignJWT({
    email,
    mfa: mfaVerified,
    gen: currentDeployGeneration(),
  })
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

export type VerifyFailureReason =
  | "invalid-token"
  | "deploy-reauth-required";

export interface VerifyResult {
  payload: SessionPayload | null;
  reason?: VerifyFailureReason;
}

/**
 * Verify and decode a session JWT with detailed failure reason. Use this in
 * auth middleware to distinguish "token is garbage" from "valid signature but
 * issued before the current deploy" — the latter should surface to clients
 * as a `deploy-reauth-required` code so the UI can show a re-login prompt.
 */
export async function verifySessionTokenDetailed(
  token: string
): Promise<VerifyResult> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    const session = payload as SessionPayload;
    // Tokens minted before the current deploy lack the current `gen` value.
    // "0" default keeps pre-feature tokens working in environments that don't
    // set DEPLOY_GENERATION yet.
    const expectedGen = currentDeployGeneration();
    const actualGen = session.gen ?? "0";
    if (actualGen !== expectedGen) {
      return { payload: null, reason: "deploy-reauth-required" };
    }
    return { payload: session };
  } catch {
    return { payload: null, reason: "invalid-token" };
  }
}

/**
 * Verify and decode a session JWT. Returns null if invalid OR if the token
 * was issued before the current deploy generation. Callers that need to
 * distinguish those two cases should use `verifySessionTokenDetailed`.
 */
export async function verifySessionToken(
  token: string
): Promise<SessionPayload | null> {
  const { payload } = await verifySessionTokenDetailed(token);
  return payload;
}
