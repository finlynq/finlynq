import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { getMode, getDbPath, isCloudReadOnly } from "@/db";
import { checkLock, forceReleaseLock, acquireLock } from "@/db/sync";
import { findConflictFiles } from "@/db/sync-checks";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;

  const mode = getMode();
  if (mode !== "cloud") {
    return NextResponse.json({ mode: "local", message: "Not in cloud sync mode" });
  }

  const dbPath = getDbPath();
  const lockStatus = checkLock(dbPath);
  const conflicts = findConflictFiles(dbPath);

  return NextResponse.json({
    mode: "cloud",
    readOnly: isCloudReadOnly(),
    lock: lockStatus,
    conflictFiles: conflicts,
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;

  const body = await request.json();
  const { action } = body;

  const dbPath = getDbPath();

  if (action === "force-release") {
    forceReleaseLock(dbPath);
    // Try to acquire the lock ourselves
    const acquired = acquireLock(dbPath);
    return NextResponse.json({
      success: true,
      acquired,
      message: acquired
        ? "Lock released and acquired. You now have write access."
        : "Lock released but could not acquire. Still in read-only mode.",
    });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
