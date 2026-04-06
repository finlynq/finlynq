import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { DEFAULT_USER_ID } from "@/db";

/**
 * Returns true if dev mode is enabled in the settings table.
 * Dev mode defaults to false when the key is absent.
 */
export async function isDevModeEnabled(): Promise<boolean> {
  try {
    const row = await db
      .select({ value: schema.settings.value })
      .from(schema.settings)
      .where(
        and(
          eq(schema.settings.key, "dev_mode"),
          eq(schema.settings.userId, DEFAULT_USER_ID)
        )
      )
      .then((rows) => rows[0]);
    return row?.value === "true";
  } catch {
    return false;
  }
}

/**
 * API guard — returns a 404 Not Found response if dev mode is disabled.
 *
 * Usage in route handlers:
 *   const devGuard = await requireDevMode(request);
 *   if (devGuard) return devGuard;
 */
export async function requireDevMode(_request?: NextRequest): Promise<NextResponse | null> {
  const enabled = await isDevModeEnabled();
  if (!enabled) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return null;
}
