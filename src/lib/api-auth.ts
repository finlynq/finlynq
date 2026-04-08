/**
 * API key management — works in both self-hosted (SQLite) and managed (PostgreSQL) modes.
 *
 * In self-hosted mode, a single key is tied to DEFAULT_USER_ID.
 * In managed mode, each user has their own key (stored with their user_id).
 */

import { NextRequest } from "next/server";
import { db, schema, DEFAULT_USER_ID, getDialect } from "@/db";
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

  if (getDialect() === "postgres") {
    // postgres: use raw execute to avoid insert/onConflict type issues
    const { sql } = await import("drizzle-orm");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any).execute(sql`
      INSERT INTO settings (key, user_id, value)
      VALUES (${API_KEY_SETTING}, ${userId}, ${key})
      ON CONFLICT (key, user_id) DO UPDATE SET value = EXCLUDED.value
    `);
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any)
      .insert(schema.settings)
      .values({ key: API_KEY_SETTING, userId, value: key })
      .run();
  }

  return key;
}

/**
 * Regenerate (replace) the API key for the given user.
 */
export async function regenerateApiKey(userId: string = DEFAULT_USER_ID): Promise<string> {
  const key = `pf_${crypto.randomBytes(24).toString("hex")}`;

  if (getDialect() === "postgres") {
    const { sql } = await import("drizzle-orm");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any).execute(sql`
      INSERT INTO settings (key, user_id, value)
      VALUES (${API_KEY_SETTING}, ${userId}, ${key})
      ON CONFLICT (key, user_id) DO UPDATE SET value = EXCLUDED.value
    `);
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any)
      .delete(schema.settings)
      .where(and(eq(schema.settings.key, API_KEY_SETTING), eq(schema.settings.userId, userId)))
      .run();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any)
      .insert(schema.settings)
      .values({ key: API_KEY_SETTING, userId, value: key })
      .run();
  }

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
  // URL token: ?token=pf_xxx (for Claude.ai / connectors that only accept a plain URL)
  let urlToken: string | null = null;
  try { urlToken = request.nextUrl.searchParams.get("token"); } catch { /* ignore */ }
  const headerKey = xApiKey ?? bearerKey ?? (urlToken?.startsWith("pf_") ? urlToken : null);

  if (!headerKey) {
    return "Missing X-API-Key or Authorization: Bearer <key> header";
  }

  if (getDialect() === "sqlite") {
    // Self-hosted: single key for DEFAULT_USER_ID
    const storedKey = await getOrCreateApiKey(DEFAULT_USER_ID);
    if (headerKey !== storedKey) return "Invalid API key";
    return { userId: DEFAULT_USER_ID };
  }

  // Postgres: look up which user owns this key
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
