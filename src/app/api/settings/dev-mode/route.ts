import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { requireAdmin } from "@/lib/auth/require-admin";
import { db, schema, DEFAULT_USER_ID } from "@/db";
import { isDevModeEnabled } from "@/lib/require-dev-mode";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  const devMode = await isDevModeEnabled();
  return NextResponse.json({ devMode });
}

export async function PUT(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.authenticated) return auth.response;

  const body = await request.json();
  const devMode = body.devMode === true;
  const value = devMode ? "true" : "false";

  // Upsert via insert + onConflictDoUpdate (same pattern as email-config)
  await db
    .insert(schema.settings)
    .values({ key: "dev_mode", userId: DEFAULT_USER_ID, value })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } as any });

  return NextResponse.json({ devMode });
}
