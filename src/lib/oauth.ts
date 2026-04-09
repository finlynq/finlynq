/**
 * OAuth 2.1 utilities — PKCE, code/token generation, validation.
 *
 * Uses raw SQL via the db proxy to avoid SQLite/PG type conflicts
 * (these tables only exist in PG mode).
 */

import crypto from "crypto";
import { db } from "@/db";
import { sql } from "drizzle-orm";

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

/** Generate and store an authorization code. Returns the code string. */
export async function createAuthCode(opts: {
  userId: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  clientId: string;
}): Promise<string> {
  const code = crypto.randomBytes(32).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + AUTH_CODE_TTL_MS).toISOString();

  await pgDb.execute(sql`
    INSERT INTO oauth_authorization_codes
      (user_id, code, code_challenge, code_challenge_method, redirect_uri, client_id, expires_at, used, created_at)
    VALUES
      (${opts.userId}, ${code}, ${opts.codeChallenge}, ${opts.codeChallengeMethod},
       ${opts.redirectUri}, ${opts.clientId}, ${expiresAt}, 0, ${now.toISOString()})
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
};

/** Consume an authorization code. Returns userId if valid, null otherwise. */
export async function consumeAuthCode(opts: {
  code: string;
  redirectUri: string;
  clientId: string;
  codeVerifier: string;
}): Promise<{ userId: string } | null> {
  const result = await pgDb.execute(sql`
    SELECT * FROM oauth_authorization_codes WHERE code = ${opts.code} LIMIT 1
  `);
  const rows: AuthCodeRow[] = result.rows ?? result ?? [];
  if (!rows.length) return null;
  const row = rows[0];

  if (row.used) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  if (row.client_id !== opts.clientId) return null;
  if (row.redirect_uri !== opts.redirectUri) return null;

  // PKCE verification
  if (row.code_challenge_method === "S256") {
    if (!verifyPkceS256(opts.codeVerifier, row.code_challenge)) return null;
  } else {
    if (opts.codeVerifier !== row.code_challenge) return null;
  }

  // Mark as used
  await pgDb.execute(sql`
    UPDATE oauth_authorization_codes SET used = 1 WHERE id = ${row.id}
  `);

  return { userId: row.user_id };
}

// ─── Access Tokens ───────────────────────────────────────────────────────────

/** Issue a new access + refresh token pair. */
export async function createAccessToken(userId: string, clientId: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const accessToken = `pf_oauth_${crypto.randomBytes(32).toString("hex")}`;
  const refreshToken = `pf_refresh_${crypto.randomBytes(32).toString("hex")}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL_MS).toISOString();
  const refreshExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS).toISOString();

  await pgDb.execute(sql`
    INSERT INTO oauth_access_tokens
      (user_id, token, refresh_token, client_id, expires_at, refresh_expires_at, created_at)
    VALUES
      (${userId}, ${accessToken}, ${refreshToken}, ${clientId}, ${expiresAt}, ${refreshExpiresAt}, ${now.toISOString()})
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
};

/** Validate an OAuth access token. Returns userId if valid, null otherwise. */
export async function validateOauthToken(token: string): Promise<{ userId: string } | null> {
  const result = await pgDb.execute(sql`
    SELECT user_id, expires_at FROM oauth_access_tokens WHERE token = ${token} LIMIT 1
  `);
  const rows: Pick<TokenRow, "user_id" | "expires_at">[] = result.rows ?? result ?? [];
  if (!rows.length) return null;
  if (new Date(rows[0].expires_at) < new Date()) return null;
  return { userId: rows[0].user_id };
}

/** Refresh an access token. Old pair is deleted; new pair is returned. */
export async function refreshAccessToken(refreshToken: string, clientId: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
} | null> {
  const result = await pgDb.execute(sql`
    SELECT * FROM oauth_access_tokens
    WHERE refresh_token = ${refreshToken} AND client_id = ${clientId}
    LIMIT 1
  `);
  const rows: TokenRow[] = result.rows ?? result ?? [];
  if (!rows.length) return null;
  if (new Date(rows[0].refresh_expires_at) < new Date()) return null;

  const { id, user_id } = rows[0];

  await pgDb.execute(sql`DELETE FROM oauth_access_tokens WHERE id = ${id}`);

  return createAccessToken(user_id, clientId);
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
