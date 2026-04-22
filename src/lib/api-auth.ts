/**
 * API key management — PostgreSQL-only mode
 *
 * Each user has their own key (stored with their user_id).
 *
 * Envelope encryption (Phase 2):
 *   Alongside the API key itself, we store a second wrap of the user's DEK
 *   in the settings table under key='api_key_dek'. The wrapping key is
 *   derived from the API key secret via HKDF/SHA-256. This lets MCP
 *   requests (Bearer pf_... auth) unwrap the DEK without needing a live
 *   browser session.
 */

import { NextRequest } from "next/server";
import { db, schema, DEFAULT_USER_ID } from "@/db";
import { eq, and } from "drizzle-orm";
import crypto from "crypto";

const API_KEY_SETTING = "api_key";
const API_KEY_DEK_SETTING = "api_key_dek";

/** Derive a 32-byte wrap key from a random high-entropy secret (API key,
 * OAuth access token, webhook secret, etc). SHA-256 is deterministic and
 * sufficient because the input is already ≥192 bits of crypto-random data;
 * no extra stretching is needed. */
export function secretWrapKey(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret).digest();
}

/**
 * Wrap a DEK with a key derived from a high-entropy secret.
 * Stored format: base64(iv || ciphertext || tag).
 *
 * Works for any random secret: API key, OAuth access token, webhook secret.
 */
export function wrapDEKForSecret(dek: Buffer, secret: string): string {
  const wrapKey = secretWrapKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", wrapKey, iv);
  const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

/** Unwrap a DEK previously wrapped via wrapDEKForSecret. */
export function unwrapDEKForSecret(wrapped: string, secret: string): Buffer {
  const buf = Buffer.from(wrapped, "base64");
  if (buf.length < 12 + 16 + 32) throw new Error("Wrapped DEK too short");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  const wrapKey = secretWrapKey(secret);
  const decipher = crypto.createDecipheriv("aes-256-gcm", wrapKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// Back-compat aliases — older call sites and the api-key path use these names.
export const wrapDEKForApiKey = wrapDEKForSecret;
export const unwrapDEKForApiKey = unwrapDEKForSecret;

/**
 * Persist the API-key-wrapped DEK alongside the API key in settings.
 * Called when a user creates or regenerates their API key while logged in.
 */
async function storeApiKeyDEK(userId: string, wrapped: string): Promise<void> {
  const { sql } = await import("drizzle-orm");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).execute(sql`
    INSERT INTO settings (key, user_id, value)
    VALUES (${API_KEY_DEK_SETTING}, ${userId}, ${wrapped})
    ON CONFLICT (key, user_id) DO UPDATE SET value = EXCLUDED.value
  `);
}

/** Remove any stored API-key-wrapped DEK for this user. Used on key regeneration. */
async function clearApiKeyDEK(userId: string): Promise<void> {
  const { sql } = await import("drizzle-orm");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).execute(sql`
    DELETE FROM settings WHERE key = ${API_KEY_DEK_SETTING} AND user_id = ${userId}
  `);
}

/**
 * Get or generate an API key for the given user.
 * If `dek` is provided (caller is logged in), the DEK is also wrapped for
 * Bearer auth. If not provided, the key works but MCP reads will 423 until
 * the user regenerates while logged in.
 */
export async function getOrCreateApiKey(
  userId: string = DEFAULT_USER_ID,
  dek?: Buffer
): Promise<string> {
  const existing = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(and(eq(schema.settings.key, API_KEY_SETTING), eq(schema.settings.userId, userId)))
    .get();

  if (existing) return existing.value as string;

  const key = `pf_${crypto.randomBytes(24).toString("hex")}`;

  const { sql } = await import("drizzle-orm");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).execute(sql`
    INSERT INTO settings (key, user_id, value)
    VALUES (${API_KEY_SETTING}, ${userId}, ${key})
    ON CONFLICT (key, user_id) DO UPDATE SET value = EXCLUDED.value
  `);

  if (dek) {
    await storeApiKeyDEK(userId, wrapDEKForApiKey(dek, key));
  }

  return key;
}

/**
 * Regenerate (replace) the API key for the given user.
 * Must be called while logged in (dek required) so the new API-key DEK
 * envelope can be written atomically with the new key.
 */
export async function regenerateApiKey(userId: string, dek: Buffer): Promise<string> {
  const key = `pf_${crypto.randomBytes(24).toString("hex")}`;

  const { sql } = await import("drizzle-orm");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).execute(sql`
    INSERT INTO settings (key, user_id, value)
    VALUES (${API_KEY_SETTING}, ${userId}, ${key})
    ON CONFLICT (key, user_id) DO UPDATE SET value = EXCLUDED.value
  `);

  await storeApiKeyDEK(userId, wrapDEKForApiKey(dek, key));

  return key;
}

/** Remove all API-key artifacts for a user (used by wipe flow). */
export async function deleteApiKey(userId: string): Promise<void> {
  const { sql } = await import("drizzle-orm");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).execute(sql`
    DELETE FROM settings WHERE key IN (${API_KEY_SETTING}, ${API_KEY_DEK_SETTING}) AND user_id = ${userId}
  `);
  void clearApiKeyDEK;
}

/**
 * Validate an API key and return the user ID + unwrapped DEK (when available).
 *
 * DEK is null for legacy API keys created before the encryption rollout;
 * callers that need encrypted-column access should treat that as a prompt
 * to have the user regenerate their key from the settings page.
 */
export async function validateApiKey(
  request: NextRequest
): Promise<{ userId: string; dek: Buffer | null } | string> {
  const xApiKey = request.headers.get("X-API-Key");
  const authHeader = request.headers.get("authorization") ?? "";
  const bearerKey = authHeader.startsWith("Bearer pf_") ? authHeader.slice(7) : null;
  const headerKey = xApiKey ?? bearerKey;

  if (!headerKey) {
    return "Missing X-API-Key or Authorization: Bearer <key> header";
  }

  // Find the owning user by matching the key value.
  const rows = await db
    .select({ userId: schema.settings.userId })
    .from(schema.settings)
    .where(
      and(
        eq(schema.settings.key, API_KEY_SETTING),
        eq(schema.settings.value, headerKey)
      )
    )
    .execute();

  if (!rows.length) return "Invalid API key";
  const userId = rows[0].userId as string;

  // Look up the DEK wrap (if any) and unwrap with the API key.
  const dekRows = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(
      and(
        eq(schema.settings.key, API_KEY_DEK_SETTING),
        eq(schema.settings.userId, userId)
      )
    )
    .execute();

  let dek: Buffer | null = null;
  const wrapped = dekRows[0]?.value as string | undefined;
  if (wrapped) {
    try {
      dek = unwrapDEKForApiKey(wrapped, headerKey);
    } catch {
      // Corrupted or mismatched wrap — treat as no-DEK. Valid key still authenticates.
      dek = null;
    }
  }

  return { userId, dek };
}
