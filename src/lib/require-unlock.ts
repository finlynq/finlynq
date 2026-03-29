import { NextResponse } from "next/server";
import { isUnlocked } from "@/db";

/**
 * API guard — returns a 423 Locked response if the database is not unlocked.
 * Add `const locked = requireUnlock(); if (locked) return locked;` to each route handler.
 */
export function requireUnlock(): NextResponse | null {
  if (!isUnlocked()) {
    return NextResponse.json(
      { error: "Database is locked. Enter your passphrase to unlock." },
      { status: 423 }
    );
  }
  return null;
}
