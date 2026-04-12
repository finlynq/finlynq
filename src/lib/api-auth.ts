/**
 * API key management — PostgreSQL-only mode
 *
 * Each user has their own key (stored with their user_id).
 */

import { NextRequest } from "next/server";
import { db, schema, DEFAULT_USER_ID } from "@/db";
import { eq, and } from "drizzle-orm";
import crypto from "crypto";

const API_KEY_SETTING = "api_key";

/**
 * Get or generate an API key for the given user.
 * Creates a new key on first access.
 */
export async function getOrCreateApiKey(userId: string = DEFAULT_USER_ID): Promise<string> {
  const existing = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(and(eq(schema.settings.key, API_KEY_SETTING), eq(schema.settings.userId, userId)))
    .get();

  if (existing) return existing.value as string;

  const key = `pf_${crypto.randomBytes(24).toString("hex")}`;

  // PostgreSQL: use raw execute to avoid insert/onConflict type issues
  const { sql } = await import("drizzle-orm");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).execute(sql`
    INSERT INTO settings (key, user_id, value)
    VALUES (${API_KEY_SETTING}, ${userId}, ${key})
    ON CONFLICT (key, user_id) DO UPDATE SET value = EXCLUDED.value
  `);

  return key;
}

/**
 * Regenerate (replace) the API key for the given user.
 */
export async function regenerateApiKey(userId: string = DEFAULT_USER_ID): Promise<string> {
  const key = `pf_${crypto.randomBytes(24).toString("hex")}`;

  // PostgreSQL: use raw execute
  const { sql } = await import("drizzle-orm");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).execute(sql`
    INSERT INTO settings (key, user_id, value)
    VALUES (${API_KEY_SETTING}, ${userId}, ${key})
    ON CONFLICT (key, user_id) DO UPDATE SET value = EXCLUDED.value
  `);

  return key;
}

/**
 * Validate an API key from the request.
 *
 * Accepts:
 *   Authorization: Bearer pf_<key>
 *   X-API-Key: pf_<key>
 *   ?token=pf_<key>  (URL query parameter — for clients that only accept a URL)
 *
 * Returns { userId } on success, or an error string on failure.
 */
export async function validateApiKey(request: NextRequest): Promise<{ userId: string } | string> {
  const xApiKey = request.headers.get("X-API-Key");
  const authHeader = request.headers.get("authorization") ?? "";
  const bearerKey = authHeader.startsWith("Bearer pf_") ? authHeader.slice(7) : null;
  // URL token support removed for security — tokens in URLs leak via logs, history, and Referer headers.
  // API keys must be sent via X-API-Key header or Authorization: Bearer header.
  const headerKey = xApiKey ?? bearerKey;

  if (!headerKey) {
    return "Missing X-API-Key or Authorization: Bearer <key> header";
  }

  // PostgreSQL: look up which user owns this key
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
  return { userId: rows[0].userId as string };
}
