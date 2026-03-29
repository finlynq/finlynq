// Simple X-API-Key authentication for API routes
// Key is stored in the settings table and generated on first access.

import { NextRequest } from "next/server";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import crypto from "crypto";

const API_KEY_SETTING = "api_key";

/**
 * Get or generate the API key from the settings table.
 * Creates a new key on first access.
 */
export function getOrCreateApiKey(): string {
  const existing = db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, API_KEY_SETTING))
    .get();

  if (existing) return existing.value;

  // Generate a new API key
  const key = `pf_${crypto.randomBytes(24).toString("hex")}`;
  db.insert(schema.settings).values({ key: API_KEY_SETTING, value: key }).run();
  return key;
}

/**
 * Validate X-API-Key header against the stored key.
 * Returns null if valid, or an error message if invalid.
 */
export function validateApiKey(request: NextRequest): string | null {
  const headerKey = request.headers.get("X-API-Key");

  if (!headerKey) {
    return "Missing X-API-Key header";
  }

  const storedKey = getOrCreateApiKey();

  if (headerKey !== storedKey) {
    return "Invalid API key";
  }

  return null; // Valid
}
