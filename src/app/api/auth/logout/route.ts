/**
 * POST /api/auth/logout — Clear the session (managed edition).
 *
 * Also wipes the user's DEK from the in-memory cache so a stolen cookie
 * can't resurrect decrypted data access after logout.
 */

import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { deleteDEK } from "@/lib/crypto/dek-cache";

export async function POST(request: NextRequest) {
  // Read the JWT before we blank the cookie so we can target its jti.
  const token = request.cookies.get(AUTH_COOKIE)?.value;
  if (token) {
    const payload = await verifySessionToken(token);
    const jti = (payload?.jti as string | undefined) ?? null;
    if (jti) deleteDEK(jti);
  }

  const response = NextResponse.json({ success: true });

  response.cookies.set(AUTH_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });

  return response;
}
