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

// ─── Constants ───────────────────────────────────────────────────────────────

export const AUTH_CODE_TTL_MS = 10 * 60 * 1000;               // 10 minutes
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;            // 1 hour
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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
 */
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  const hash = crypto.createHash("sha256").update(codeVerifier, "ascii").digest();
  const computed = hash.toString("base64url");
  return computed === codeChallenge;
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
}): Promise<string> {
  const code = crypto.randomBytes(32).toString("hex");
  const codeHash = authLookupHash(code);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + AUTH_CODE_TTL_MS).toISOString();
  // DEK wrap uses the raw code; stored value is the hash. Domain-separated
  // derivations mean the stored hash is not the wrap key.
  const dekWrapped = opts.dek ? wrapDEKForSecret(opts.dek, code) : null;

  await pgDb.execute(sql`
    INSERT INTO oauth_authorization_codes
      (user_id, code, code_challenge, code_challenge_method, redirect_uri, client_id, expires_at, used, created_at, dek_wrapped)
    VALUES
      (${opts.userId}, ${codeHash}, ${opts.codeChallenge}, ${opts.codeChallengeMethod},
       ${opts.redirectUri}, ${opts.clientId}, ${expiresAt}, 0, ${now.toISOString()}, ${dekWrapped})
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
}): Promise<{ userId: string; dek: Buffer | null } | null> {
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

  // PKCE verification
  if (row.code_challenge_method === "S256") {
    if (!verifyPkceS256(opts.codeVerifier, row.code_challenge)) return null;
  } else {
    if (opts.codeVerifier !== row.code_challenge) return null;
  }

  let dek: Buffer | null = null;
  if (row.dek_wrapped) {
    try {
      dek = unwrapDEKForSecret(row.dek_wrapped, opts.code);
    } catch {
      dek = null;
    }
  }

  return { userId: row.user_id, dek };
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
  dek?: Buffer | null
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
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
      (user_id, token, refresh_token, client_id, expires_at, refresh_expires_at, created_at, dek_wrapped, dek_wrapped_refresh)
    VALUES
      (${userId}, ${accessHash}, ${refreshHash}, ${clientId}, ${expiresAt}, ${refreshExpiresAt}, ${now.toISOString()}, ${dekWrapped}, ${dekWrappedRefresh})
  `);

  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_MS / 1000 };
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
};

/**
 * Validate an OAuth access token. Returns {userId, dek} if valid, null otherwise.
 * Revoked tokens (rotated or killed by reuse-detection) are rejected.
 */
export async function validateOauthToken(token: string): Promise<{ userId: string; dek: Buffer | null } | null> {
  const tokenHash = authLookupHash(token);
  const result = await pgDb.execute(sql`
    SELECT user_id, expires_at, dek_wrapped
      FROM oauth_access_tokens
     WHERE token = ${tokenHash}
       AND revoked_at IS NULL
     LIMIT 1
  `);
  const rows: Pick<TokenRow, "user_id" | "expires_at" | "dek_wrapped">[] = result.rows ?? result ?? [];
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
  return { userId: rows[0].user_id, dek };
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

  const { user_id, dek_wrapped_refresh } = rows[0];

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

  return createAccessToken(user_id, clientId, dek);
}

// ─── Redirect URI validation ──────────────────────────────────────────────────

/** Allow any HTTPS URI, or localhost/127.0.0.1 for dev */
export function isValidRedirectUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.protocol === "https:") return true;
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return true;
    return false;
  } catch {
    return false;
  }
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

/** Register a new OAuth client and return its metadata. */
export async function registerClient(input: ClientRegistrationInput): Promise<RegisteredClient> {
  const clientId = crypto.randomUUID();
  const clientName = input.client_name ?? "Unknown Client";
  const redirectUris = input.redirect_uris ?? [];
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
