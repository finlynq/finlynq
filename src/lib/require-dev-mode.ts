import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";

/**
 * Returns true if dev mode is enabled for the given user.
 * Dev mode is a per-user UI preference; defaults to false when absent.
 */
export async function isDevModeEnabled(userId: string): Promise<boolean> {
  try {
    const row = await db
      .select({ value: schema.settings.value })
      .from(schema.settings)
      .where(
        and(
          eq(schema.settings.key, "dev_mode"),
          eq(schema.settings.userId, userId)
        )
      )
      .then((rows) => rows[0]);
    return row?.value === "true";
  } catch {
    return false;
  }
}

/**
 * API guard — returns a 404 Not Found response if dev mode is disabled
 * for the authenticated user, or 401 if unauthenticated.
 *
 * Usage in route handlers:
 *   const devGuard = await requireDevMode(request);
 *   if (devGuard) return devGuard;
 */
export async function requireDevMode(request: NextRequest): Promise<NextResponse | null> {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const enabled = await isDevModeEnabled(auth.context.userId);
  if (!enabled) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return null;
}
