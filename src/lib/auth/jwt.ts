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
 *   sign in again" screen instead of a generic error.
 *
 *   In production the value is REQUIRED — the resolver throws if unset,
 *   because the silent `"0"` fallback meant a deploy that forgot to stamp
 *   the env produced JWTs that survived every subsequent (also-unstamped)
 *   restart, defeating the force-logout invariant. In development the
 *   resolver still falls back to `"0"` so local servers keep working.
 *
 * Pending tokens (B7, 2026-05-07):
 *   /api/auth/login mints a 5-minute "pending" token when the user has
 *   MFA enabled. The token carries `pending: true`. The default account
 *   strategy rejects pending tokens for every route except /api/auth/mfa/verify
 *   so a captured pending cookie can't access dashboards or transactions.
 *   On successful MFA verification the pending jti is INSERTed into
 *   `revoked_jtis` (server-side denylist) so a captured pending token
 *   can't be replayed.
 *
 * Revocation list (B7, 2026-05-07):
 *   `revoked_jtis` is the server-side denylist consulted on every request.
 *   /api/auth/logout INSERTs the current jti so a stolen cookie can't
 *   resurrect plaintext-only data access after sign-out.
 *   /api/auth/mfa/verify INSERTs the pending jti after issuing the real
 *   session.
 *   The denylist is cached in-process for 30s to keep the auth hot path
 *   snappy — short enough that revocation latency is bounded, long enough
 *   that rapid-fire requests don't hammer the DB.
 */

import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import crypto from "crypto";

/** JWT claims for authenticated sessions */
export interface SessionPayload extends JWTPayload {
  sub: string; // user ID — the source of truth for identity
  jti: string; // unique session ID (used as key for DEK cache)
  mfa: boolean; // whether MFA was verified
  gen?: string; // deploy-generation stamp; rejected if it doesn't match current env
  /**
   * Pending tokens issued during the MFA challenge step. The default account
   * strategy rejects pending tokens for every route except /api/auth/mfa/verify,
   * so a captured pending cookie can't access dashboards or transactions.
   * Absent on full sessions to avoid wasting a claim slot on the common case.
   */
  pending?: boolean;
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
  const gen = process.env.DEPLOY_GENERATION;
  if (gen) return gen;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "DEPLOY_GENERATION is required in production. deploy.sh stamps this with `date +%s` before restarting the service; if you're seeing this, the systemd drop-in at /etc/systemd/system/<service>.service.d/deploy-generation.conf is missing or didn't load. Fix the deploy step rather than setting a static value — the whole point is forced re-auth on every restart."
    );
  }
  // Dev only — keeps local servers working without a stamped env.
  return "0";
}

/** Options for creating a session token. */
export interface CreateSessionTokenOptions {
  /**
   * Override the JWT exp. Accepts the same shape `jose.setExpirationTime`
   * accepts ("5m", "24h", a number of seconds, or a Date). Defaults to 24h.
   * Pending tokens (mfaPending step) should pass "5m".
   */
  expirationTime?: string | number | Date;
  /**
   * Mark this token as a pending MFA challenge step. The default account
   * strategy rejects pending tokens for every route except
   * /api/auth/mfa/verify.
   */
  pending?: boolean;
}

/**
 * Create a signed JWT for the given user session. Returns token + jti.
 *
 * The token carries `sub` (userId), `jti`, `mfa`, and `gen` only — identity
 * fields (email, username, displayName) are looked up fresh from the DB on
 * every session check via /api/auth/session, so the JWT never embeds them.
 * This keeps tokens identity-agnostic and means renaming a username doesn't
 * require token rotation.
 *
 * Pending tokens (B7) carry `pending: true` and a 5m TTL so a captured
 * pending cookie has a tight blast radius. On successful MFA verification
 * the issued full session uses a fresh jti and a 24h TTL.
 */
export async function createSessionToken(
  userId: string,
  mfaVerified: boolean,
  options: CreateSessionTokenOptions = {}
): Promise<{ token: string; jti: string }> {
  const jti = crypto.randomUUID();
  const claims: Record<string, unknown> = {
    mfa: mfaVerified,
    gen: currentDeployGeneration(),
  };
  if (options.pending) claims.pending = true;
  const builder = new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setJti(jti)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(options.expirationTime ?? EXPIRATION);
  const token = await builder.sign(getSecret());
  return { token, jti };
}

export type VerifyFailureReason =
  | "invalid-token"
  | "deploy-reauth-required"
  | "revoked";

export interface VerifyResult {
  payload: SessionPayload | null;
  reason?: VerifyFailureReason;
}

// ─── Revocation list helpers ────────────────────────────────────────────────
//
// In-process cache so the auth hot path doesn't touch the DB on every
// request. Each lookup is cached for `REVOKE_CACHE_TTL_MS`. Survives Next.js
// HMR via globalThis.
const REVOKE_CACHE_TTL_MS = 30_000;
const REVOKE_CACHE_MAX = 5_000;

interface RevokeCacheEntry {
  revoked: boolean;
  expiresAt: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _g = globalThis as any;
if (!_g.__pfRevokedJtiCache) {
  _g.__pfRevokedJtiCache = new Map<string, RevokeCacheEntry>();
}
const revokeCache: Map<string, RevokeCacheEntry> = _g.__pfRevokedJtiCache;

function getCachedRevocation(jti: string): boolean | null {
  const entry = revokeCache.get(jti);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    revokeCache.delete(jti);
    return null;
  }
  return entry.revoked;
}

function cacheRevocation(jti: string, revoked: boolean): void {
  // Bound the cache. When at capacity, evict the oldest (insertion-ordered Map).
  if (revokeCache.size >= REVOKE_CACHE_MAX) {
    const firstKey = revokeCache.keys().next().value;
    if (firstKey !== undefined) revokeCache.delete(firstKey);
  }
  revokeCache.set(jti, {
    revoked,
    expiresAt: Date.now() + REVOKE_CACHE_TTL_MS,
  });
}

/**
 * Returns true if the jti has been revoked (logged-out / promoted-from-pending).
 * Cached in-process for 30s to keep the auth path snappy. The cache is
 * write-on-read; calls to `revokeJti` invalidate the cache entry directly.
 *
 * The DB lookup is best-effort: if the query throws (table missing on a
 * pre-migration env, or pool exhausted) we return false rather than locking
 * every authenticated request out. Logging happens at the caller level via
 * the auth strategy.
 */
export async function isJtiRevoked(jti: string): Promise<boolean> {
  if (!jti) return false;
  const cached = getCachedRevocation(jti);
  if (cached !== null) return cached;
  try {
    // Lazy-import to avoid pulling pg into edge runtime preflight.
    const { db } = await import("@/db");
    const { revokedJtis } = await import("@/db/schema-pg");
    const { eq } = await import("drizzle-orm");
    const rows = await db
      .select({ jti: revokedJtis.jti })
      .from(revokedJtis)
      .where(eq(revokedJtis.jti, jti))
      .limit(1);
    const revoked = rows.length > 0;
    cacheRevocation(jti, revoked);
    return revoked;
  } catch {
    // DB lookup failed — fail open so the auth path doesn't lock everyone out.
    // The rest of the auth chain still validates signature, gen, and exp.
    return false;
  }
}

/**
 * INSERT a jti into the revocation list. Idempotent — duplicates are
 * absorbed via `ON CONFLICT DO NOTHING`. `expiresAt` should be the JWT's
 * original `exp` (in ms since epoch); the cleanup cron drops rows past
 * their exp because the signature would already fail.
 */
export async function revokeJti(
  jti: string,
  expiresAt: Date
): Promise<void> {
  if (!jti) return;
  try {
    const { db } = await import("@/db");
    const { revokedJtis } = await import("@/db/schema-pg");
    await db
      .insert(revokedJtis)
      .values({ jti, expiresAt })
      .onConflictDoNothing({ target: revokedJtis.jti });
    // Bust the in-process cache so the next isJtiRevoked() sees the truth.
    revokeCache.set(jti, {
      revoked: true,
      expiresAt: Date.now() + REVOKE_CACHE_TTL_MS,
    });
  } catch {
    // Swallow — caller (logout / mfa-verify) shouldn't fail because the
    // denylist write didn't land. JWT exp will eventually clean the token up.
  }
}

/** Clear the in-process revoked-jti cache. Used by tests. */
export function _clearRevokedJtiCache(): void {
  revokeCache.clear();
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
    // The "0" fallback on `actualGen` is harmless because in production
    // `expectedGen` is forced to a real timestamp by `currentDeployGeneration()`,
    // so any token without a `gen` claim fails the equality check below.
    const expectedGen = currentDeployGeneration();
    const actualGen = session.gen ?? "0";
    if (actualGen !== expectedGen) {
      return { payload: null, reason: "deploy-reauth-required" };
    }
    // Server-side JWT denylist — H-5 (logout doesn't revoke) and H-4
    // (pending tokens are reusable). The DB lookup is cached in-process.
    if (session.jti && (await isJtiRevoked(session.jti))) {
      return { payload: null, reason: "revoked" };
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

/** Convenience helper used by route handlers. */
export function isPendingToken(payload: SessionPayload | null): boolean {
  return Boolean(payload?.pending);
}
