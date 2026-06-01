/**
 * POST /api/auth/delete-account — Password-confirmed PERMANENT account deletion.
 *
 * Deletes every per-user data row AND the `users` identity row itself, then
 * logs the user out by clearing the session cookie. This is the irreversible
 * sibling of POST /api/auth/wipe-account (which keeps the user row and rotates
 * the DEK). It is the real backing for the public /account-deletion page and
 * the Play Store "delete account" requirement.
 *
 * Gating mirrors wipe-account (B7 hardening, finding H-7):
 *  - Rejects the API-key auth strategy — `pf_*` keys are scoped permission
 *    tokens that must not be able to nuke the account. Account session only.
 *  - Requires the user's password.
 *  - Requires a fresh MFA code when the user has MFA enabled — a stolen cookie
 *    (no authenticator in hand) can no longer trigger the delete.
 *  - Rate-limited to 3 attempts per hour per (user, IP).
 *  - Evicts EVERY cached DEK for the user post-delete.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { getDialect } from "@/db";
import { AUTH_COOKIE, verifyPassword, verifyMfaCode } from "@/lib/auth";
import { requireAuth } from "@/lib/auth/require-auth";
import { getUserById, deleteUserAccount } from "@/lib/auth/queries";
import { decryptField } from "@/lib/crypto/envelope";
import { getDEK, evictAllForUser } from "@/lib/crypto/dek-cache";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { validateBody, safeErrorMessage } from "@/lib/validate";
import { checkRateLimit } from "@/lib/rate-limit";

const deleteSchema = z.object({
  password: z.string().min(1, "Password is required"),
  confirmation: z.literal("DELETE", {
    message: "Confirmation phrase must be exactly 'DELETE'",
  }),
  /**
   * Required when the user has MFA enabled. 6-digit TOTP code. Optional in the
   * schema so users without MFA can call with the existing two-field shape.
   */
  mfaCode: z.string().length(6, "Code must be 6 digits").optional(),
});

/**
 * Same dummy-bcrypt pattern as login / wipe-account (finding H-3). The
 * authenticated user lookup can still 404 (e.g. a session JWT outliving the
 * underlying user row after an admin delete) and we'd rather pay a fixed
 * bcrypt cost than expose a wall-clock difference between "user gone" and
 * "user exists, password wrong".
 */
const DUMMY_BCRYPT_HASH = bcrypt.hashSync(
  "never-actually-matched-anything",
  12
);

export async function POST(request: NextRequest) {
  if (getDialect() !== "postgres") {
    return NextResponse.json(
      { error: "Account deletion is only available in managed mode." },
      { status: 403 }
    );
  }

  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, sessionId, method } = auth.context;

  // H-7: API keys are scoped permission tokens — they must not be able to
  // delete the account. Only the interactive account session (cookie / Bearer
  // JWT) can delete.
  if (method !== "account") {
    return NextResponse.json(
      {
        error:
          "API keys are not allowed to delete the account. Sign in via the web app to delete.",
      },
      { status: 403 }
    );
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rate = checkRateLimit(`delete:${userId}:${ip}`, 3, 3600_000);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again in an hour." },
      { status: 429 }
    );
  }

  try {
    const body = await request.json();
    const parsed = validateBody(body, deleteSchema);
    if (parsed.error) return parsed.error;

    const user = await getUserById(userId);
    if (!user) {
      // Finding H-3 — pay the bcrypt cost even when the user row is gone so
      // wall-clock timing doesn't leak the user-exists/user-deleted state.
      await verifyPassword(parsed.data.password, DUMMY_BCRYPT_HASH);
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const ok = await verifyPassword(parsed.data.password, user.passwordHash);
    if (!ok) {
      return NextResponse.json(
        { error: "Password is incorrect." },
        { status: 401 }
      );
    }

    // H-7: require fresh MFA when enabled. The TOTP code is the closest we
    // can get to "fresh" without storing a server-side challenge.
    if (user.mfaEnabled && user.mfaSecret) {
      if (!parsed.data.mfaCode) {
        return NextResponse.json(
          {
            error: "MFA verification is required to delete the account.",
            code: "mfa-required",
          },
          { status: 401 }
        );
      }
      const dek = sessionId ? getDEK(sessionId, userId) : null;
      if (!dek) {
        // Without the session DEK we can't decrypt the MFA secret — bounce
        // the user back to the login flow.
        return NextResponse.json(
          { error: "Session expired. Please sign in again to delete." },
          { status: 423 }
        );
      }
      let decryptedSecret: string | null;
      try {
        decryptedSecret = decryptField(dek, user.mfaSecret);
      } catch {
        return NextResponse.json(
          {
            error: "MFA secret could not be decrypted. Please contact support.",
          },
          { status: 500 }
        );
      }
      if (
        !decryptedSecret ||
        !verifyMfaCode(decryptedSecret, parsed.data.mfaCode)
      ) {
        return NextResponse.json(
          { error: "Invalid MFA code." },
          { status: 401 }
        );
      }
    }

    // Point of no return — deletes all data + the users row in one transaction.
    // A FK 23503 (e.g. an admin self-deleting with admin_audit rows) rolls the
    // whole thing back and surfaces below as a 500.
    await deleteUserAccount(userId);

    // The identity is gone — drop every cached DEK for this user across all
    // sessions/devices and clear the MCP tx cache.
    evictAllForUser(userId);
    invalidateUserTxCache(userId);

    // Log the requesting browser out. No revokeJti is needed: the user row is
    // gone, so any stale cookie on another device fails the user lookup on its
    // next request, and the DEK cache was just evicted above.
    const response = NextResponse.json({
      success: true,
      message: "Account deleted.",
    });
    response.cookies.set(AUTH_COOKIE, "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 0,
      path: "/",
    });
    return response;
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Account deletion failed") },
      { status: 500 }
    );
  }
}
