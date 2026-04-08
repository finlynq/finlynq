// Simple X-API-Key authentication for API routes
// Key is stored in the settings table and generated on first access.

import { NextRequest } from "next/server";
import { db, schema, DEFAULT_USER_ID, getDialect } from "@/db";
import { eq, and } from "drizzle-orm";
import crypto from "crypto";

const API_KEY_SETTING = "api_key";

/**
 * Get or generate the API key for a given user.
 * In self-hosted (sqlite) mode userId defaults to DEFAULT_USER_ID.
 */
export async function getOrCreateApiKey(userId: string = DEFAULT_USER_ID): Promise<string> {
  const existing = await db
    .select()
    .from(schema.settings)
    .where(and(eq(schema.settings.key, API_KEY_SETTING), eq(schema.settings.userId, userId)))
    .get();

  if (existing) return existing.value;

  const key = `pf_${crypto.randomBytes(24).toString("hex")}`;
  await db
    .insert(schema.settings)
    .values({ key: API_KEY_SETTING, userId, value: key })
    .run();
  return key;
}

/**
 * Validate X-API-Key (or Authorization: Bearer pf_...) against stored keys.
 * Returns { userId } on success or an error string on failure.
 *
 * In sqlite/self-hosted mode: validates against the single stored key and returns DEFAULT_USER_ID.
 * In postgres/cloud mode: looks up the key across all users and returns the owning userId.
 */
export async function validateApiKey(
  request: NextRequest
): Promise<{ userId: string } | string> {
  const headerKey =
    request.headers.get("X-API-Key") ??
    (() => {
      const auth = request.headers.get("authorization") ?? "";
      return auth.startsWith("Bearer pf_") ? auth.slice(7) : null;
    })();

  if (!headerKey) {
    return "Missing X-API-Key or Authorization: Bearer <key> header";
  }

  if (getDialect() === "sqlite") {
    // Self-hosted: single key, auto-create on first use
    const storedKey = await getOrCreateApiKey(DEFAULT_USER_ID);
    if (headerKey !== storedKey) return "Invalid API key";
    return { userId: DEFAULT_USER_ID };
  }

  // Postgres/cloud: look up the key across all user rows
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
  return { userId: rows[0].userId };
}
