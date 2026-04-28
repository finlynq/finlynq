import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { db, schema } from "@/db";
import { isDevModeEnabled } from "@/lib/require-dev-mode";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  const devMode = await isDevModeEnabled(auth.context.userId);
  return NextResponse.json({ devMode });
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  const body = await request.json();
  const devMode = body.devMode === true;
  const value = devMode ? "true" : "false";

  await db
    .insert(schema.settings)
    .values({ key: "dev_mode", userId: auth.context.userId, value })
    .onConflictDoUpdate({
      target: [schema.settings.key, schema.settings.userId],
      set: { value },
    });

  return NextResponse.json({ devMode });
}
