import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { readConfig, writeConfig, resolveDbPath } from "@shared/config";
import { getMode, getDbPath } from "@/db";
import fs from "fs";
import { z } from "zod";
import { validateBody, safeErrorMessage } from "@/lib/validate";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;

  const config = readConfig();
  const dbPath = resolveDbPath(config);
  let fileSize = 0;
  try {
    const stats = fs.statSync(dbPath);
    fileSize = stats.size;
  } catch {
    // file may not exist yet
  }

  return NextResponse.json({
    dbPath: config.dbPath,
    resolvedPath: dbPath,
    mode: getMode(),
    fileSize,
  });
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;

  try {
  const body = await request.json();

  const storageSchema = z.object({
    dbPath: z.string().optional(),
    mode: z.enum(["local", "cloud"]).optional(),
  });
  const parsed = validateBody(body, storageSchema);
  if (parsed.error) return parsed.error;

  const { dbPath, mode } = parsed.data;

  const config = readConfig();

  if (dbPath !== undefined) {
    config.dbPath = dbPath;
  }
  if (mode !== undefined) {
    config.mode = mode;
  }

  writeConfig(config);

  return NextResponse.json({
    success: true,
    message: "Storage settings updated. Restart the app to apply changes.",
  });
  } catch (error: unknown) {
    const message = safeErrorMessage(error, "Failed to update storage settings");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
