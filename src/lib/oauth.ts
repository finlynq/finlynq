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
import { DEFAULT_SCOPE, normalizeRequestedScope, InvalidScopeError } from "@/lib/oauth-scopes";

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

/** Cap on `redirect_uris` per registered client. RFC 7591 doesn't mandate one,
 * but accepting an unbounded list lets a single DCR call seed every URI a
 * future attacker might want to reuse. Five is plenty for legitimate clients
 * (dev / staging / prod / mobile / desktop) and keeps the DB row small. */
export const MAX_REDIRECT_URIS_PER_CLIENT = 5;

/** The issuer / base URL for OAuth metadata. */
export function getIssuer(): string {
  return (process.env.APP_URL ?? "https://finance.nextsoftwareconsulting.com").replace(/\/$/, "");
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
  const rows: AuthCodeRow[] = result.rows ?? result ?? [];
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
  const rows: Pick<TokenRow, "user_id" | "expires_at" | "dek_wrapped" | "scope">[] = result.rows ?? result ?? [];
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
  const rows: ClientRow[] = result.rows ?? result ?? [];
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
