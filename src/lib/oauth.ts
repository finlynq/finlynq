/**
 * OAuth 2.1 utilities — PKCE, code/token generation, validation.
 *
 * Uses raw SQL via the db proxy to avoid SQLite/PG type conflicts
 * (these tables only exist in PG mode).
 */

import crypto from "crypto";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { wrapDEKForSecret, unwrapDEKForSecret, authLookupHash } from "@/lib/api-auth";
import { normalizeDbRows } from "@/lib/db-utils";
import { bumpLastActive } from "@/lib/auth/last-active";
import { DEFAULT_SCOPE, normalizeRequestedScope } from "@/lib/oauth-scopes";

export { DEFAULT_SCOPE, InvalidScopeError } from "@/lib/oauth-scopes";

// ─── Constants ───────────────────────────────────────────────────────────────

// RFC 6749 §4.1.2 recommends auth codes "have a maximum lifetime of 10 minutes"
// but explicitly notes "should be short lived" — production OAuth deployments
// typically issue 60–120s. The code carries the wrapped DEK, so a stolen code
// is a DEK-exfil primitive; tightening to 60s narrows the window dramatically
// while still leaving plenty of slack for the network round-trip a legit
// client makes between the redirect callback and `/api/oauth/token`.
export const AUTH_CODE_TTL_MS = 60 * 1000;                    // 60 seconds
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;            // 1 hour
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * FINLYNQ-167 — minimum staleness before another `last_used_at` bump is written.
 * Mirrors FINLYNQ-166's `LAST_ACTIVE_THROTTLE_MINUTES` (15–30 min budget): the
 * UPDATE only matches when the stored value is NULL or older than this window,
 * so token validation is NOT a write-per-request.
 */
export const LAST_USED_THROTTLE_MINUTES = 15;

/** Cap on `redirect_uris` per registered client. RFC 7591 doesn't mandate one,
 * but accepting an unbounded list lets a single DCR call seed every URI a
 * future attacker might want to reuse. Five is plenty for legitimate clients
 * (dev / staging / prod / mobile / desktop) and keeps the DB row small. */
export const MAX_REDIRECT_URIS_PER_CLIENT = 5;

/** The issuer / base URL for OAuth metadata.
 *
 * `APP_URL` is the single source of truth (self-hosters set it; docker-compose
 * defaults it to http://localhost:3000). When it's unset we fall back to
 * localhost so a fresh self-host still produces *working* metadata — and we
 * warn in production, where an unset APP_URL means MCP connector setup will
 * advertise localhost to clients that can't reach it. */
export function getIssuer(): string {
  const appUrl = process.env.APP_URL;
  if (!appUrl) {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[oauth] APP_URL is not set — OAuth issuer metadata is falling back to " +
          "http://localhost:3000. Set APP_URL to your public origin so MCP " +
          "connector setup advertises the right URL."
      );
    }
    return "http://localhost:3000";
  }
  return appUrl.replace(/\/$/, "");
}

// Typed shorthand for the raw PG executor
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pgDb = db as any;

// ─── PKCE ────────────────────────────────────────────────────────────────────

/**
 * Verify a PKCE S256 code_verifier against a stored code_challenge.
 * code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))
 *
 * Uses `timingSafeEqual` for the byte comparison. The code challenge is
 * technically public (it shipped on the redirect URL), so a timing leak here
 * isn't directly exploitable — but the cost of `timingSafeEqual` is one extra
 * Buffer comparison and the discipline pays off if the function is ever
 * reused in a context where the challenge is sensitive.
 */
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  const hash = crypto.createHash("sha256").update(codeVerifier, "ascii").digest();
  const computed = hash.toString("base64url");
  // Length-equal first: timingSafeEqual throws on mismatched lengths, and a
  // length difference is a fast non-cryptographic signal anyway.
  if (computed.length !== codeChallenge.length) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(computed, "ascii"),
      Buffer.from(codeChallenge, "ascii")
    );
  } catch {
    return false;
  }
}

/**
 * Validate a PKCE `code_challenge_method` parameter.
 *
 * Only `S256` is accepted. RFC 7636 §4.2 explicitly notes that `plain` is
 * "NOT RECOMMENDED" and OAuth 2.1 (draft-ietf-oauth-v2-1) requires `S256`.
 * Our `.well-known/oauth-authorization-server` already advertises
 * `code_challenge_methods_supported: ["S256"]`, so accepting `plain` was a
 * server-side bug, not a documented capability.
 *
 * Returns `true` only when the method is the exact string "S256". An undefined
 * or empty method is rejected — callers must pass it explicitly.
 */
export function isValidPkceMethod(method: string | undefined): boolean {
  return method === "S256";
}

// ─── Authorization Codes ─────────────────────────────────────────────────────

/**
 * Generate and store an authorization code. Returns the code string.
 *
 * If `dek` is supplied, it's wrapped with a key derived from the auth code
 * and stored alongside. The token-exchange step will unwrap with the code
 * and re-wrap with the access token. If the caller has no DEK (rare — only
 * happens when the authorizing user pre-dates the encryption rollout and
 * hasn't logged in since) the code still works but MCP reads will return
 * ciphertext.
 */
export async function createAuthCode(opts: {
  userId: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  clientId: string;
  dek?: Buffer | null;
  /** Space-separated OAuth scope tokens. Defaults to DEFAULT_SCOPE if omitted. */
  scope?: string;
}): Promise<string> {
  // Defense-in-depth: route handlers should already have rejected non-S256
  // methods, but if a caller bypasses that check we MUST NOT persist a `plain`
  // challenge — `consumeAuthCode` rejects non-S256 anyway, but issuing a code
  // that can never validate is a silent footgun.
  if (!isValidPkceMethod(opts.codeChallengeMethod)) {
    throw new Error("Invalid code_challenge_method — only S256 is supported");
  }
  const scope = normalizeRequestedScope(opts.scope ?? DEFAULT_SCOPE);
  const code = crypto.randomBytes(32).toString("hex");
  const codeHash = authLookupHash(code);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + AUTH_CODE_TTL_MS).toISOString();
  // DEK wrap uses the raw code; stored value is the hash. Domain-separated
  // derivations mean the stored hash is not the wrap key.
  const dekWrapped = opts.dek ? wrapDEKForSecret(opts.dek, code) : null;

  await pgDb.execute(sql`
    INSERT INTO oauth_authorization_codes
      (user_id, code, code_challenge, code_challenge_method, redirect_uri, client_id, expires_at, used, created_at, dek_wrapped, scope)
    VALUES
      (${opts.userId}, ${codeHash}, ${opts.codeChallenge}, ${opts.codeChallengeMethod},
       ${opts.redirectUri}, ${opts.clientId}, ${expiresAt}, 0, ${now.toISOString()}, ${dekWrapped}, ${scope})
  `);

  return code;
}

type AuthCodeRow = {
  id: number;
  user_id: string;
  code: string;
  code_challenge: string;
  code_challenge_method: string;
  redirect_uri: string;
  client_id: string;
  expires_at: string;
  used: number;
  dek_wrapped: string | null;
  scope: string | null;
};

/**
 * Consume an authorization code. Returns {userId, dek} if valid, null otherwise.
 *
 * Uses `DELETE ... RETURNING` for an atomic claim so two concurrent token
 * exchanges on the same code can't both succeed. The row (including its
 * `dek_wrapped`) is removed from the DB the moment it's claimed — no more
 * spent codes piling up for a future DB-read attacker to attempt offline.
 *
 * `dek` is the unwrapped per-user DEK (if the authorizing session had one).
 * Caller should re-wrap under the newly-issued access token.
 */
export async function consumeAuthCode(opts: {
  code: string;
  redirectUri: string;
  clientId: string;
  codeVerifier: string;
}): Promise<{ userId: string; dek: Buffer | null; scope: string } | null> {
  // Atomic claim — at most one caller gets the row; everyone else sees empty.
  // Lookup by hash; the raw code is never stored in DB.
  const codeHash = authLookupHash(opts.code);
  const result = await pgDb.execute(sql`
    DELETE FROM oauth_authorization_codes WHERE code = ${codeHash} RETURNING *
  `);
  const rows = normalizeDbRows<AuthCodeRow>(result);
  if (!rows.length) return null;
  const row = rows[0];

  if (new Date(row.expires_at) < new Date()) return null;
  if (row.client_id !== opts.clientId) return null;
  if (row.redirect_uri !== opts.redirectUri) return null;

  // PKCE verification — only S256 is accepted. The `plain` branch was removed
  // for defense-in-depth: `createAuthCode` and `/api/oauth/authorize` already
  // refuse to issue a code with `plain`, but a row predating those checks (or
  // a future bug that bypasses them) must not validate here either.
  if (row.code_challenge_method !== "S256") return null;
  if (!verifyPkceS256(opts.codeVerifier, row.code_challenge)) return null;

  let dek: Buffer | null = null;
  if (row.dek_wrapped) {
    try {
      dek = unwrapDEKForSecret(row.dek_wrapped, opts.code);
    } catch {
      dek = null;
    }
  }

  // Pre-PR rows have no scope column data; treat absence as DEFAULT_SCOPE so
  // existing tokens keep their pre-rollout full-access semantics.
  const scope = (row.scope && row.scope.trim().length > 0) ? row.scope : DEFAULT_SCOPE;

  return { userId: row.user_id, dek, scope };
}

// ─── Access Tokens ───────────────────────────────────────────────────────────

/**
 * Issue a new access + refresh token pair. If a DEK is supplied, it's
 * wrapped with a key derived from the new access token so MCP requests on
 * that token can unwrap and read encrypted columns.
 */
export async function createAccessToken(
  userId: string,
  clientId: string,
  dek?: Buffer | null,
  scope?: string
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}> {
  const tokenScope = normalizeRequestedScope(scope ?? DEFAULT_SCOPE);
  const accessToken = `pf_oauth_${crypto.randomBytes(32).toString("hex")}`;
  const refreshToken = `pf_refresh_${crypto.randomBytes(32).toString("hex")}`;
  const accessHash = authLookupHash(accessToken);
  const refreshHash = authLookupHash(refreshToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL_MS).toISOString();
  const refreshExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS).toISOString();
  // Two envelopes: one unwrappable with the access token (validateOauthToken),
  // one with the refresh token (refreshAccessToken carries DEK forward without
  // ever storing the old access token plaintext).
  const dekWrapped = dek ? wrapDEKForSecret(dek, accessToken) : null;
  const dekWrappedRefresh = dek ? wrapDEKForSecret(dek, refreshToken) : null;

  await pgDb.execute(sql`
    INSERT INTO oauth_access_tokens
      (user_id, token, refresh_token, client_id, expires_at, refresh_expires_at, created_at, dek_wrapped, dek_wrapped_refresh, scope)
    VALUES
      (${userId}, ${accessHash}, ${refreshHash}, ${clientId}, ${expiresAt}, ${refreshExpiresAt}, ${now.toISOString()}, ${dekWrapped}, ${dekWrappedRefresh}, ${tokenScope})
  `);

  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_MS / 1000, scope: tokenScope };
}

type TokenRow = {
  id: number;
  user_id: string;
  token: string;
  refresh_token: string;
  client_id: string;
  expires_at: string;
  refresh_expires_at: string;
  dek_wrapped: string | null;
  dek_wrapped_refresh: string | null;
  revoked_at: string | null;
  scope: string | null;
};

/**
 * FINLYNQ-167 — throttled bump of `oauth_access_tokens.last_used_at` for the
 * grant whose access token hashes to `tokenHash`.
 *
 * Like FINLYNQ-166's `bumpLastActive`, the throttle is DB-SIDE: the UPDATE's
 * WHERE clause only matches when the stored value is NULL or older than the
 * window, so a second validation inside the window matches zero rows and writes
 * nothing (no read-then-write race, no write-per-request storm). Keyed on the
 * access-token hash (matches `token`, not `refresh_token`) so per-grant
 * last-used reflects active-token use. Fire-and-forget: callers MUST NOT await
 * it on the request critical path and it NEVER throws (errors swallowed).
 *
 * Returns a Promise that always resolves; safe to call without awaiting.
 */
async function bumpTokenLastUsed(tokenHash: string): Promise<void> {
  try {
    await pgDb.execute(sql`
      UPDATE oauth_access_tokens
         SET last_used_at = NOW()
       WHERE token = ${tokenHash}
         AND revoked_at IS NULL
         AND (
           last_used_at IS NULL
           OR last_used_at < NOW() - (${LAST_USED_THROTTLE_MINUTES} || ' minutes')::interval
         )
    `);
  } catch {
    // Never block or fail the token-validation path on a metadata-write error.
  }
}

/**
 * Validate an OAuth access token. Returns {userId, dek} if valid, null otherwise.
 * Revoked tokens (rotated or killed by reuse-detection) are rejected.
 */
export async function validateOauthToken(token: string): Promise<{ userId: string; dek: Buffer | null; scope: string } | null> {
  const tokenHash = authLookupHash(token);
  const result = await pgDb.execute(sql`
    SELECT user_id, expires_at, dek_wrapped, scope
      FROM oauth_access_tokens
     WHERE token = ${tokenHash}
       AND revoked_at IS NULL
     LIMIT 1
  `);
  const rows = normalizeDbRows<Pick<TokenRow, "user_id" | "expires_at" | "dek_wrapped" | "scope">>(result);
  if (!rows.length) return null;
  if (new Date(rows[0].expires_at) < new Date()) return null;

  let dek: Buffer | null = null;
  if (rows[0].dek_wrapped) {
    try {
      dek = unwrapDEKForSecret(rows[0].dek_wrapped, token);
    } catch {
      dek = null;
    }
  }
  // Pre-PR rows have no scope; treat absence as DEFAULT_SCOPE for back-compat.
  const scope = (rows[0].scope && rows[0].scope.trim().length > 0) ? rows[0].scope : DEFAULT_SCOPE;
  // FINLYNQ-166 — advance last_active_at on every successful OAuth/MCP token
  // validation. This is the path last_login_at misses entirely. DB-side-throttled
  // + fire-and-forget so it never blocks or fails token validation.
  void bumpLastActive(rows[0].user_id);
  // FINLYNQ-167 — advance THIS grant's last_used_at (DB-side-throttled,
  // fire-and-forget) so the admin OAuth-grants panel can show per-grant
  // last-used + an active/dormant flag.
  void bumpTokenLastUsed(tokenHash);
  return { userId: rows[0].user_id, dek, scope };
}

/**
 * Refresh an access token.
 *
 * Rotation + reuse detection. The old pair is marked `revoked_at = now()`
 * atomically with the claim (UPDATE ... RETURNING) — this both prevents
 * double-rotations on the same refresh token and leaves a forensic record.
 *
 * If a caller presents a refresh token that's already been revoked (i.e.
 * the row exists but `revoked_at IS NOT NULL`), we treat that as a
 * token-theft signal and revoke every live token for that user. Legitimate
 * clients never replay a refresh token once they've received the new pair,
 * so a revoked-token presentation is always suspicious.
 */
export async function refreshAccessToken(refreshToken: string, clientId: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
} | null> {
  const nowIso = new Date().toISOString();
  const refreshHash = authLookupHash(refreshToken);

  // Atomic claim: flip the live row to revoked_at = now() and return it.
  const claim = await pgDb.execute(sql`
    UPDATE oauth_access_tokens
       SET revoked_at = now()
     WHERE refresh_token = ${refreshHash}
       AND client_id = ${clientId}
       AND revoked_at IS NULL
       AND refresh_expires_at > ${nowIso}
     RETURNING *
  `);
  const rows: TokenRow[] = claim.rows ?? claim ?? [];

  if (!rows.length) {
    // Three reasons we'd get here: (a) unknown refresh token, (b) expired,
    // (c) already revoked. Case (c) is the theft signal — the legit user
    // has already rotated, so any further use of the old token is either an
    // attacker replay or a broken client. Either way, kill all live tokens
    // for that user to contain the blast radius.
    const recheck = await pgDb.execute(sql`
      SELECT user_id FROM oauth_access_tokens
       WHERE refresh_token = ${refreshHash}
         AND client_id = ${clientId}
         AND revoked_at IS NOT NULL
       LIMIT 1
    `);
    const revokedRows: Pick<TokenRow, "user_id">[] = recheck.rows ?? recheck ?? [];
    if (revokedRows.length) {
      await pgDb.execute(sql`
        UPDATE oauth_access_tokens
           SET revoked_at = now()
         WHERE user_id = ${revokedRows[0].user_id}
           AND revoked_at IS NULL
      `);
    }
    return null;
  }

  const { user_id, dek_wrapped_refresh, scope: oldScope } = rows[0];

  // Unwrap DEK using the refresh-token-wrapped envelope. We never stored the
  // old access token plaintext, so the refresh path uses its own envelope.
  let dek: Buffer | null = null;
  if (dek_wrapped_refresh) {
    try {
      dek = unwrapDEKForSecret(dek_wrapped_refresh, refreshToken);
    } catch {
      dek = null;
    }
  }

  // Refresh preserves scope. RFC 6749 §6 explicitly forbids scope ESCALATION
  // on refresh ("the requested scope MUST NOT include any scope not originally
  // granted"). We don't accept a `scope` parameter on refresh at all — the
  // refreshed token gets exactly the original scope. Pre-PR rows without a
  // scope column fall back to DEFAULT_SCOPE.
  const preservedScope = (oldScope && oldScope.trim().length > 0) ? oldScope : DEFAULT_SCOPE;

  return createAccessToken(user_id, clientId, dek, preservedScope);
}

// ─── Token revocation (RFC 7009 + connected-apps + reset) ─────────────────────

/**
 * Revoke a single presented token (RFC 7009).
 *
 * Each `oauth_access_tokens` row IS one grant — it carries both the access
 * token (`token`) and its refresh token (`refresh_token`). A presented token
 * could be either, so we match on EITHER column and flip the whole row to
 * `revoked_at = now()`. That kills the access AND refresh side of the grant in
 * one shot, which also satisfies RFC 7009 §2.1's "if the token passed is a
 * refresh token … the authorization server SHOULD revoke … access tokens based
 * on the same authorization grant."
 *
 * Only live rows are touched (`revoked_at IS NULL`), so re-revoking an
 * already-revoked token is a no-op. The caller (the RFC 7009 endpoint) returns
 * 200 regardless of how many rows matched — never leaking whether the token
 * existed.
 *
 * `token_type_hint` is accepted by the endpoint but intentionally ignored here:
 * matching both columns is correct whether the hint is right, wrong, or absent.
 */
export async function revokeGrant(token: string): Promise<void> {
  const tokenHash = authLookupHash(token);
  await pgDb.execute(sql`
    UPDATE oauth_access_tokens
       SET revoked_at = now()
     WHERE (token = ${tokenHash} OR refresh_token = ${tokenHash})
       AND revoked_at IS NULL
  `);
}

/**
 * Revoke a single grant by its row id, scoped to the owning user.
 *
 * Used by the Settings "Connected apps" Revoke button. The `user_id` predicate
 * is load-bearing — it prevents one user revoking another user's grant by
 * guessing a row id. Flipping `revoked_at` on the row kills both the access and
 * refresh sides of that grant at once.
 *
 * Returns true if a live row was revoked, false if the id was unknown,
 * already-revoked, or owned by a different user.
 */
export async function revokeGrantById(userId: string, grantId: number): Promise<boolean> {
  const result = await pgDb.execute(sql`
    UPDATE oauth_access_tokens
       SET revoked_at = now()
     WHERE id = ${grantId}
       AND user_id = ${userId}
       AND revoked_at IS NULL
     RETURNING id
  `);
  const rows = normalizeDbRows<{ id: number }>(result);
  return rows.length > 0;
}

/**
 * Revoke ALL live grants for a user.
 *
 * Called from the forgot-password WIPE flow so a reset cuts off every OAuth
 * client that still holds a (now-orphaned) wrapped DEK. (The wipe also DELETEs
 * these rows, so this is defense-in-depth / explicit intent — and it's the
 * primitive a future password-change rewrap path can reuse without a wipe.)
 *
 * Returns the number of rows revoked.
 */
export async function revokeAllForUser(userId: string): Promise<number> {
  const result = await pgDb.execute(sql`
    UPDATE oauth_access_tokens
       SET revoked_at = now()
     WHERE user_id = ${userId}
       AND revoked_at IS NULL
     RETURNING id
  `);
  const rows = normalizeDbRows<{ id: number }>(result);
  return rows.length;
}

/** A live OAuth grant as shown in Settings → Connected apps. */
export interface ConnectedApp {
  /** Row id — used as the revoke target. */
  id: number;
  clientId: string;
  clientName: string;
  scope: string;
  createdAt: string;
  /** Access-token expiry (ISO). The refresh token (30d) keeps the grant alive
   *  past this — surfaced so the UI can note an idle vs. fresh grant later. */
  expiresAt: string;
}

/**
 * List a user's live OAuth grants for the Connected-apps UI.
 *
 * "Live" = not revoked AND the refresh token hasn't expired (the access token
 * may already be past its 1h TTL but the grant is still re-issuable until the
 * 30-day refresh window lapses — that's the meaningful "is this app still
 * connected" signal). Joins `oauth_clients` for the human-readable name; an
 * orphaned client_id (client row gone) falls back to the raw client_id.
 *
 * Per the FINLYNQ-154 triage scope this deliberately omits last-used —
 * `last_used_at` was split to FINLYNQ-167.
 */
export async function listConnectedApps(userId: string): Promise<ConnectedApp[]> {
  const nowIso = new Date().toISOString();
  const result = await pgDb.execute(sql`
    SELECT t.id, t.client_id, t.scope, t.created_at, t.expires_at, c.client_name
      FROM oauth_access_tokens t
      LEFT JOIN oauth_clients c ON c.client_id = t.client_id
     WHERE t.user_id = ${userId}
       AND t.revoked_at IS NULL
       AND t.refresh_expires_at > ${nowIso}
     ORDER BY t.created_at DESC
  `);
  type Row = {
    id: number;
    client_id: string;
    scope: string | null;
    created_at: string;
    expires_at: string;
    client_name: string | null;
  };
  const rows = normalizeDbRows<Row>(result);
  return rows.map((r) => ({
    id: r.id,
    clientId: r.client_id,
    clientName: (r.client_name && r.client_name.trim().length > 0) ? r.client_name : r.client_id,
    scope: (r.scope && r.scope.trim().length > 0) ? r.scope : DEFAULT_SCOPE,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }));
}

// ─── Admin OAuth-grants panel (FINLYNQ-167) ───────────────────────────────────

/** A live OAuth grant across all users, for the operator-side admin panel. */
export interface AdminGrant {
  /** Row id — used as the revoke target. */
  id: number;
  /** Owning user id. */
  userId: string;
  /** Owner identity for display (best-effort; plaintext columns on `users`). */
  userLabel: string;
  clientId: string;
  clientName: string;
  scope: string;
  createdAt: string;
  /** Access-token expiry (ISO). */
  expiresAt: string;
  /** Last successful token validation (ISO), throttled DB-side. NULL = never
   *  validated since the column was added. Drives the dormant flag. */
  lastUsedAt: string | null;
}

/**
 * List every live OAuth grant across ALL users for the admin panel.
 *
 * "Live" mirrors `listConnectedApps`: not revoked AND the refresh token hasn't
 * expired (the access token may already be past its 1h TTL but the grant is
 * still re-issuable until the 30-day refresh window lapses). Joins
 * `oauth_clients` for the human-readable client name and `users` for an owner
 * label (displayName ?? username ?? email — all plaintext columns on `users`).
 *
 * Operator-scoped: callers MUST gate this behind `requireAdmin`. The dormant
 * flag (last_used_at NULL or > 60d) is computed at the UI boundary via the pure
 * `isDormant` helper, NOT here, so this stays a plain listing query.
 */
export async function listAllGrants(): Promise<AdminGrant[]> {
  const nowIso = new Date().toISOString();
  const result = await pgDb.execute(sql`
    SELECT t.id, t.user_id, t.client_id, t.scope, t.created_at, t.expires_at, t.last_used_at,
           c.client_name, u.display_name, u.username, u.email
      FROM oauth_access_tokens t
      LEFT JOIN oauth_clients c ON c.client_id = t.client_id
      LEFT JOIN users u ON u.id = t.user_id
     WHERE t.revoked_at IS NULL
       AND t.refresh_expires_at > ${nowIso}
     ORDER BY t.last_used_at DESC NULLS LAST, t.created_at DESC
  `);
  type Row = {
    id: number;
    user_id: string;
    client_id: string;
    scope: string | null;
    created_at: string;
    expires_at: string;
    last_used_at: string | null;
    client_name: string | null;
    display_name: string | null;
    username: string | null;
    email: string | null;
  };
  const rows = normalizeDbRows<Row>(result);
  return rows.map((r) => {
    const label =
      (r.display_name && r.display_name.trim().length > 0 && r.display_name) ||
      (r.username && r.username.trim().length > 0 && r.username) ||
      (r.email && r.email.trim().length > 0 && r.email) ||
      r.user_id;
    return {
      id: r.id,
      userId: r.user_id,
      userLabel: label,
      clientId: r.client_id,
      clientName: (r.client_name && r.client_name.trim().length > 0) ? r.client_name : r.client_id,
      scope: (r.scope && r.scope.trim().length > 0) ? r.scope : DEFAULT_SCOPE,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      lastUsedAt: r.last_used_at,
    };
  });
}

/**
 * Admin revoke of a single grant by its row id — NOT owner-scoped.
 *
 * The operator-side analogue of `revokeGrantById`: there is no `user_id`
 * predicate because an admin acts across users. Callers MUST gate this behind
 * `requireAdmin`. Flipping `revoked_at` kills both the access and refresh sides
 * of the grant at once. Returns true if a live row was revoked, false if the id
 * was unknown or already revoked.
 */
export async function revokeGrantByIdAdmin(grantId: number): Promise<boolean> {
  const result = await pgDb.execute(sql`
    UPDATE oauth_access_tokens
       SET revoked_at = now()
     WHERE id = ${grantId}
       AND revoked_at IS NULL
     RETURNING id
  `);
  const rows = normalizeDbRows<{ id: number }>(result);
  return rows.length > 0;
}

// ─── Redirect URI validation ──────────────────────────────────────────────────

/**
 * Scheme/host-level check used at registration time. A `redirect_uri` is
 * acceptable to register only if it is HTTPS, or if it is `http://localhost`
 * / `http://127.0.0.1` (with optional port and path) for local development.
 *
 * This is NOT the runtime check that authorize uses — at runtime we require
 * exact-string membership against the client's registered list, which closes
 * the open-redirect vector entirely (a registered URI is verbatim what the
 * code is delivered to). See `isRegisteredRedirectUri` for the runtime check.
 */
export function isAcceptableRedirectScheme(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") {
    // Allow http://localhost or http://127.0.0.1 (optional port, optional path).
    // Reject any other http: host — a public-internet http target leaks the
    // auth code (and our wrapped DEK) over the wire.
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return true;
  }
  return false;
}

/**
 * Runtime membership check. The presented `redirect_uri` must exactly match
 * one of the URIs the client registered. No scheme-only match, no prefix
 * match, no host-only match — the registered URI is delivered as-is.
 *
 * Returns false if the registered list is empty, since after the registration
 * tightening (see `registerClient`) every client is guaranteed to have a
 * non-empty list. Callers can rely on the membership semantic alone.
 */
export function isRegisteredRedirectUri(uri: string, registered: string[]): boolean {
  if (!Array.isArray(registered) || registered.length === 0) return false;
  if (typeof uri !== "string" || uri.length === 0) return false;
  return registered.includes(uri);
}

/**
 * @deprecated — kept only as a thin wrapper so any external callers don't
 * hard-fail. Internal callers should use `isAcceptableRedirectScheme` (at
 * registration time) or `isRegisteredRedirectUri` (at runtime).
 */
export function isValidRedirectUri(uri: string): boolean {
  return isAcceptableRedirectScheme(uri);
}

// ─── Dynamic Client Registration (RFC 7591) ──────────────────────────────────

export interface ClientRegistrationInput {
  client_name?: string;
  redirect_uris?: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
}

export interface RegisteredClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
}

/**
 * RFC 7591 error response shape. Thrown by `registerClient` when validation
 * fails so the route handler can map it to a `400` with the standard body.
 */
export class ClientRegistrationError extends Error {
  readonly error: string;
  readonly error_description: string;

  constructor(error: string, description: string) {
    super(`${error}: ${description}`);
    this.error = error;
    this.error_description = description;
  }
}

/**
 * Validate the `redirect_uris` array supplied to `registerClient`.
 *
 * RFC 7591 §2 lists `redirect_uris` as one of the metadata fields for clients
 * that use the `authorization_code` grant. We require it for every client we
 * register because:
 *
 *   - Without a non-empty list, the runtime authorize handler had a
 *     "allow any if empty" branch that turned the registry into an open
 *     redirect — anyone with a freshly-registered client_id could deliver
 *     the auth code (and our wrapped DEK) to attacker.example.com.
 *   - Per-URI scheme validation (HTTPS or localhost only) closes the
 *     plaintext-leak vector for the auth code in transit.
 *
 * Returns the canonicalized array on success; throws `ClientRegistrationError`
 * with an RFC 7591-shaped error code on failure.
 */
function validateRedirectUris(input: unknown): string[] {
  if (!Array.isArray(input)) {
    throw new ClientRegistrationError(
      "invalid_redirect_uri",
      "redirect_uris must be a non-empty array of URIs"
    );
  }
  if (input.length === 0) {
    throw new ClientRegistrationError(
      "invalid_redirect_uri",
      "redirect_uris must contain at least one URI"
    );
  }
  if (input.length > MAX_REDIRECT_URIS_PER_CLIENT) {
    throw new ClientRegistrationError(
      "invalid_redirect_uri",
      `redirect_uris must contain at most ${MAX_REDIRECT_URIS_PER_CLIENT} entries`
    );
  }
  const out: string[] = [];
  for (const entry of input) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new ClientRegistrationError(
        "invalid_redirect_uri",
        "redirect_uris entries must be non-empty strings"
      );
    }
    if (!isAcceptableRedirectScheme(entry)) {
      throw new ClientRegistrationError(
        "invalid_redirect_uri",
        `redirect_uri "${entry}" must be HTTPS, or http://localhost / http://127.0.0.1 for local development`
      );
    }
    out.push(entry);
  }
  return out;
}

/** Register a new OAuth client and return its metadata. */
export async function registerClient(input: ClientRegistrationInput): Promise<RegisteredClient> {
  const clientId = crypto.randomUUID();
  const clientName = input.client_name ?? "Unknown Client";
  // Reject empty / oversized / scheme-invalid redirect_uris BEFORE any INSERT.
  // Without this, a freshly-registered client could authorize against any URI
  // (the authorize handler had an "allow any if list empty" branch, removed in
  // the same security batch).
  const redirectUris = validateRedirectUris(input.redirect_uris);
  const grantTypes = input.grant_types ?? ["authorization_code"];
  const responseTypes = input.response_types ?? ["code"];
  const authMethod = input.token_endpoint_auth_method ?? "none";
  const now = new Date().toISOString();

  await pgDb.execute(sql`
    INSERT INTO oauth_clients
      (client_id, client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method, created_at)
    VALUES
      (${clientId}, ${clientName}, ${JSON.stringify(redirectUris)},
       ${JSON.stringify(grantTypes)}, ${JSON.stringify(responseTypes)}, ${authMethod}, ${now})
  `);

  return { client_id: clientId, client_name: clientName, redirect_uris: redirectUris, grant_types: grantTypes, response_types: responseTypes, token_endpoint_auth_method: authMethod };
}

type ClientRow = {
  client_id: string;
  client_name: string;
  redirect_uris: string;
  grant_types: string;
  response_types: string;
  token_endpoint_auth_method: string;
};

/** Look up a registered client by client_id. Returns null if not found. */
export async function getClient(clientId: string): Promise<RegisteredClient | null> {
  const result = await pgDb.execute(sql`
    SELECT * FROM oauth_clients WHERE client_id = ${clientId} LIMIT 1
  `);
  const rows = normalizeDbRows<ClientRow>(result);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    client_id: r.client_id,
    client_name: r.client_name,
    redirect_uris: JSON.parse(r.redirect_uris ?? "[]"),
    grant_types: JSON.parse(r.grant_types ?? '["authorization_code"]'),
    response_types: JSON.parse(r.response_types ?? '["code"]'),
    token_endpoint_auth_method: r.token_endpoint_auth_method ?? "none",
  };
}
