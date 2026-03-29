import { NextResponse } from "next/server";
import { isUnlocked, getDialect } from "@/db";

/**
 * API guard — returns a 423 Locked response if the database is not unlocked.
 *
 * This is the self-hosted (passphrase) auth guard. For the unified auth
 * middleware that works across both editions, use `requireAuth()` from
 * `@/lib/auth` instead.
 *
 * Retained for backward compatibility with existing route handlers.
 * In managed (postgres) mode, this always passes through since the DB
 * connection is managed by the platform.
 */
export function requireUnlock(): NextResponse | null {
  // In managed mode, there is no passphrase lock
  if (getDialect() === "postgres") {
    return null;
  }

  if (!isUnlocked()) {
    return NextResponse.json(
      { error: "Database is locked. Enter your passphrase to unlock." },
      { status: 423 }
    );
  }
  return null;
}
