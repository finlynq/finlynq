/**
 * POST /api/auth/wipe-account — Password-confirmed full data wipe + fresh DEK.
 *
 * Used when the logged-in user wants to clear all of their data and start
 * fresh, and as the building block for the forgot-password flow (which calls
 * the same underlying wipe after token validation).
 *
 * The user row is preserved (email, MFA, plan, etc.). Everything else is
 * deleted and the DEK is regenerated and re-wrapped with the same password
 * the user just confirmed. Any cached session DEKs become stale — the
 * client should re-login.
 *
 * B7 hardening (2026-05-07, finding H-7):
 *  - Rejects the API-key auth strategy. Wipe is account-only — `pf_*` keys
 *    are scoped permission tokens that must not be able to nuke the account.
 *  - Requires a fresh MFA code when the user has MFA enabled. A stolen
 *    cookie (no MFA app in hand) can no longer trigger a destructive wipe.
 *  - Evicts EVERY DEK cache entry for the user post-wipe, not just the
 *    requesting session's slot. Other concurrent sessions would otherwise
 *    keep serving the now-rotated DEK out of memory.
 *  - `wipeUserDataAndRewrap` clears the user's MFA secret in the same
 *    transaction (M-6) — the old MFA secret was encrypted under the old
 *    DEK, would fail to decrypt after rewrap, locking the user out.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { getDialect } from "@/db";
import { verifyPassword, hashPassword, verifyMfaCode } from "@/lib/auth";
import { requireAuth } from "@/lib/auth/require-auth";
import { getUserById, wipeUserDataAndRewrap } from "@/lib/auth/queries";
import { createWrappedDEKForPassword, decryptField } from "@/lib/crypto/envelope";
import { getDEK, evictAllForUser } from "@/lib/crypto/dek-cache";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { validateBody, safeErrorMessage } from "@/lib/validate";
import { checkRateLimit } from "@/lib/rate-limit";

const wipeSchema = z.object({
  password: z.string().min(1, "Password is required"),
  confirmation: z.literal("WIPE", {
    message: "Confirmation phrase must be exactly 'WIPE'",
  }),
  /**
   * Required when the user has MFA enabled. 6-digit TOTP code from their
   * authenticator app. Optional in the schema so users without MFA can still
   * call the endpoint with the existing two-field shape.
   */
  mfaCode: z.string().length(6, "Code must be 6 digits").optional(),
});

/**
 * Finding H-3 (2026-05-07) — same dummy bcrypt hash pattern as login. The
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
      { error: "Account wipe is only available in managed mode." },
      { status: 403 }
    );
  }

  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, sessionId, method } = auth.context;

  // H-7: API keys are scoped permission tokens — they must not be able to
  // nuke the account. Only the interactive account session (cookie / Bearer
  // JWT) can wipe.
  if (method !== "account") {
    return NextResponse.json(
      {
        error:
          "API keys are not allowed to wipe account data. Sign in via the web app to wipe.",
      },
      { status: 403 }
    );
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rate = checkRateLimit(`wipe:${userId}:${ip}`, 3, 3600_000);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again in an hour." },
      { status: 429 }
    );
  }

  try {
    const body = await request.json();
    const parsed = validateBody(body, wipeSchema);
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
    // can get to "fresh" without storing a server-side challenge — a captured
    // cookie alone is not enough; the attacker also needs the authenticator.
    if (user.mfaEnabled && user.mfaSecret) {
      if (!parsed.data.mfaCode) {
        return NextResponse.json(
          {
            error:
              "MFA verification is required for account wipe.",
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
          { error: "Session expired. Please sign in again to wipe." },
          { status: 423 }
        );
      }
      let decryptedSecret: string | null;
      try {
        decryptedSecret = decryptField(dek, user.mfaSecret);
      } catch {
        return NextResponse.json(
          {
            error:
              "MFA secret could not be decrypted. Please contact support.",
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

    // Regenerate the DEK + rewrap. Same password, so existing sessions could
    // technically continue — but we evict EVERY cached DEK entry for this
    // user so the client is forced back through login and the new DEK is
    // picked up. Single-session evict (deleteDEK) was insufficient for users
    // with concurrent sessions on multiple devices.
    const { wrapped } = createWrappedDEKForPassword(parsed.data.password);
    const freshHash = await hashPassword(parsed.data.password);
    await wipeUserDataAndRewrap(userId, freshHash, {
      kekSalt: wrapped.salt.toString("base64"),
      dekWrapped: wrapped.wrapped.toString("base64"),
      dekWrappedIv: wrapped.iv.toString("base64"),
      dekWrappedTag: wrapped.tag.toString("base64"),
    });
    evictAllForUser(userId);
    invalidateUserTxCache(userId);

    return NextResponse.json({ success: true, message: "Account data wiped." });
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Account wipe failed") },
      { status: 500 }
    );
  }
}
