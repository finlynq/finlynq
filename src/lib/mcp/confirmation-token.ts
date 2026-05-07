/**
 * Confirmation-token helper for destructive / high-volume MCP operations.
 *
 * Every preview → execute pair in the MCP parity plan works like this:
 *   1. Claude calls `preview_bulk_delete({ filter })`. The handler returns
 *      the affected rows + a `confirmationToken` signed with
 *      `signConfirmationToken(userId, "bulk_delete", { ids: [...] })`.
 *   2. Claude calls `execute_bulk_delete({ confirmationToken })`. The handler
 *      calls `verifyConfirmationToken(token, userId, "bulk_delete", { ids })`
 *      with the EXACT SAME payload it plans to commit. If the hashes don't
 *      match (e.g. Claude mutated the list, or a replay against a different
 *      op) verification fails.
 *
 * Token format: `<b64url(jsonPayload)>.<b64url(hmacSha256)>`
 * Payload: `{ userId, operation, payloadHash, issuedAt, expiresAt }`
 * `payloadHash` = sha256 of a canonical JSON serialization of the user-supplied
 * payload — sorted keys, so `{a:1,b:2}` and `{b:2,a:1}` produce the same hash.
 *
 * TTL: 5 minutes (TTL_MS below). Matches the plan.
 *
 * Signed with `process.env.PF_JWT_SECRET`. Boot-time check matches
 * `src/lib/auth/jwt.ts` — refuse to sign in production if the secret is
 * missing, fall back to an ephemeral dev secret with a one-time warning
 * in non-production.
 */

import crypto from "crypto";

export const CONFIRMATION_TOKEN_TTL_MS = 5 * 60 * 1000;

// Signing key is resolved lazily so tests can mutate PF_JWT_SECRET before the
// first call. Same pattern as `src/lib/auth/jwt.ts`.
const getSecret = (() => {
  let secret: Buffer | null = null;
  let devWarned = false;
  return () => {
    if (!secret) {
      const envSecret = process.env.PF_JWT_SECRET;
      if (envSecret) {
        secret = Buffer.from(envSecret, "utf8");
      } else {
        if (process.env.NODE_ENV === "production") {
          throw new Error(
            "PF_JWT_SECRET is required in production. Refusing to sign confirmation tokens with an ephemeral secret."
          );
        }
        if (!devWarned) {
          devWarned = true;
          // eslint-disable-next-line no-console
          console.warn(
            "[mcp/confirmation-token] PF_JWT_SECRET not set — using ephemeral dev secret. Tokens won't survive restart."
          );
        }
        secret = crypto.randomBytes(32);
      }
    }
    return secret;
  };
})();

/** Internal claims carried inside the signed payload. */
export interface ConfirmationClaims {
  userId: string;
  operation: string;
  payloadHash: string;
  issuedAt: number;
  expiresAt: number;
  /**
   * Token id — random UUIDv4 minted at sign time. Used as the single-use
   * marker (M-2 in SECURITY_REVIEW 2026-05-06). Optional in the type so old
   * tokens still parse; new tokens always carry one.
   */
  jti?: string;
}

// ─── Single-use replay defense (M-2) ──────────────────────────────────────────
//
// The token format is symmetric — anyone who captures a token can replay it
// against the same userId/operation/payload until the 5-minute TTL expires.
// We mark each jti as used on the first successful verify and reject any
// future verify for the same jti. The store is a small bounded LRU keyed on
// jti with TTL = the token TTL; entries auto-expire so the map can't grow
// unboundedly. Stored on globalThis for HMR resilience.
const USED_JTI_KEY = "__pf_confirmation_used_jti__";
const USED_JTI_MAX = 10_000;
type UsedJtiStore = Map<string, number>; // jti → expiresAt
type GlobalWithUsedJti = typeof globalThis & { [USED_JTI_KEY]?: UsedJtiStore };
function getUsedJtiStore(): UsedJtiStore {
  const g = globalThis as GlobalWithUsedJti;
  if (!g[USED_JTI_KEY]) g[USED_JTI_KEY] = new Map<string, number>();
  return g[USED_JTI_KEY]!;
}
function isJtiUsed(jti: string): boolean {
  const store = getUsedJtiStore();
  const exp = store.get(jti);
  if (exp == null) return false;
  if (exp <= Date.now()) {
    store.delete(jti);
    return false;
  }
  return true;
}
function markJtiUsed(jti: string, expiresAt: number): void {
  const store = getUsedJtiStore();
  // Sweep expired entries lazily when we'd otherwise overflow the cap. Worst
  // case here is O(n) once per overflow; n is bounded at USED_JTI_MAX so the
  // amortized cost is constant.
  if (store.size >= USED_JTI_MAX) {
    const now = Date.now();
    for (const [k, v] of store) if (v <= now) store.delete(k);
    if (store.size >= USED_JTI_MAX) {
      // Still full — evict the oldest entry (Map iteration order = insertion).
      const oldest = store.keys().next().value;
      if (typeof oldest === "string") store.delete(oldest);
    }
  }
  store.set(jti, expiresAt);
}
/** Exported for tests — clears the in-memory store. */
export function __resetUsedJtiStoreForTests(): void {
  getUsedJtiStore().clear();
}

/** Canonical JSON serialization — stable key ordering so hashes are deterministic. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") +
    "}"
  );
}

function hashPayload(payload: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function b64urlEncode(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return b
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecodeToBuffer(s: string): Buffer {
  // Restore padding, swap url-safe chars back.
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  return Buffer.from(
    s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad),
    "base64"
  );
}

/** Timing-safe comparison of two buffers. */
function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Sign a confirmation token for `{userId, operation, payload}`. The returned
 * token is valid for CONFIRMATION_TOKEN_TTL_MS (5 minutes).
 *
 * `payload` can be any JSON-serializable value — it gets hashed, not stored,
 * so callers must pass the SAME payload to `verifyConfirmationToken` at
 * execute time.
 */
export function signConfirmationToken(
  userId: string,
  operation: string,
  payload: unknown
): string {
  const now = Date.now();
  const claims: ConfirmationClaims = {
    userId,
    operation,
    payloadHash: hashPayload(payload),
    issuedAt: now,
    expiresAt: now + CONFIRMATION_TOKEN_TTL_MS,
    // M-2: every token gets a unique jti; verify rejects re-use.
    jti: crypto.randomUUID(),
  };
  const payloadPart = b64urlEncode(JSON.stringify(claims));
  const mac = crypto
    .createHmac("sha256", getSecret())
    .update(payloadPart)
    .digest();
  const macPart = b64urlEncode(mac);
  return `${payloadPart}.${macPart}`;
}

export type ConfirmationVerifyFailure =
  | "malformed"
  | "bad-signature"
  | "expired"
  | "user-mismatch"
  | "operation-mismatch"
  | "payload-mismatch"
  | "replay";

export interface ConfirmationVerifyResult {
  valid: boolean;
  reason?: ConfirmationVerifyFailure;
  claims?: ConfirmationClaims;
}

/**
 * Verify a confirmation token. All three scope inputs — userId, operation,
 * payload — must match the values that were signed. The payload is hashed
 * with the same canonical JSON serialization used at sign time.
 */
export function verifyConfirmationToken(
  token: string,
  userId: string,
  operation: string,
  payload: unknown
): ConfirmationVerifyResult {
  if (typeof token !== "string" || !token.includes(".")) {
    return { valid: false, reason: "malformed" };
  }
  const [payloadPart, macPart] = token.split(".");
  if (!payloadPart || !macPart) {
    return { valid: false, reason: "malformed" };
  }

  // Verify signature first — timing-safe — before parsing claims. This prevents
  // leaking whether the payload was well-formed via timing differences.
  const expectedMac = crypto
    .createHmac("sha256", getSecret())
    .update(payloadPart)
    .digest();
  let providedMac: Buffer;
  try {
    providedMac = b64urlDecodeToBuffer(macPart);
  } catch {
    return { valid: false, reason: "malformed" };
  }
  if (!timingSafeEqual(expectedMac, providedMac)) {
    return { valid: false, reason: "bad-signature" };
  }

  let claims: ConfirmationClaims;
  try {
    const json = b64urlDecodeToBuffer(payloadPart).toString("utf8");
    claims = JSON.parse(json) as ConfirmationClaims;
  } catch {
    return { valid: false, reason: "malformed" };
  }

  if (
    typeof claims.userId !== "string" ||
    typeof claims.operation !== "string" ||
    typeof claims.payloadHash !== "string" ||
    typeof claims.expiresAt !== "number"
  ) {
    return { valid: false, reason: "malformed" };
  }

  if (Date.now() > claims.expiresAt) {
    return { valid: false, reason: "expired", claims };
  }
  if (claims.userId !== userId) {
    return { valid: false, reason: "user-mismatch", claims };
  }
  if (claims.operation !== operation) {
    return { valid: false, reason: "operation-mismatch", claims };
  }
  if (claims.payloadHash !== hashPayload(payload)) {
    return { valid: false, reason: "payload-mismatch", claims };
  }

  // M-2: single-use jti. Tokens minted before this change carry no jti — they
  // can still verify (defensive) but they aren't replay-protected. New tokens
  // always carry one and are rejected on second use.
  if (typeof claims.jti === "string" && claims.jti.length > 0) {
    if (isJtiUsed(claims.jti)) {
      return { valid: false, reason: "replay", claims };
    }
    markJtiUsed(claims.jti, claims.expiresAt);
  }

  return { valid: true, claims };
}

/** Exported for tests. */
export const __internals = { canonicalJson, hashPayload };
