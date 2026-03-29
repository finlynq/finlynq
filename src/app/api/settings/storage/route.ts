import { NextRequest, NextResponse } from "next/server";
import { requireUnlock } from "@/lib/require-unlock";
import { readConfig, writeConfig, resolveDbPath } from "@shared/config";
import { getMode, getDbPath } from "@/db";
import fs from "fs";

export async function GET() {
  const locked = requireUnlock(); if (locked) return locked;

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
  const locked = requireUnlock(); if (locked) return locked;

  const body = await request.json();
  const { dbPath, mode } = body;

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
}
