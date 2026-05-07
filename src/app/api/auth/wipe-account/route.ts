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
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { getDialect } from "@/db";
import { verifyPassword, hashPassword } from "@/lib/auth";
import { requireAuth } from "@/lib/auth/require-auth";
import { getUserById, wipeUserDataAndRewrap } from "@/lib/auth/queries";
import { createWrappedDEKForPassword } from "@/lib/crypto/envelope";
import { deleteDEK } from "@/lib/crypto/dek-cache";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { validateBody, safeErrorMessage } from "@/lib/validate";
import { checkRateLimit } from "@/lib/rate-limit";

const wipeSchema = z.object({
  password: z.string().min(1, "Password is required"),
  confirmation: z.literal("WIPE", {
    message: "Confirmation phrase must be exactly 'WIPE'",
  }),
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
  const { userId, sessionId } = auth.context;

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

    // Regenerate the DEK + rewrap. Same password, so existing sessions could
    // technically continue — but we invalidate this session's cache entry so
    // the client is forced back through login and the new DEK is picked up.
    const { wrapped } = createWrappedDEKForPassword(parsed.data.password);
    const freshHash = await hashPassword(parsed.data.password);
    await wipeUserDataAndRewrap(userId, freshHash, {
      kekSalt: wrapped.salt.toString("base64"),
      dekWrapped: wrapped.wrapped.toString("base64"),
      dekWrappedIv: wrapped.iv.toString("base64"),
      dekWrappedTag: wrapped.tag.toString("base64"),
    });
    if (sessionId) deleteDEK(sessionId);
    invalidateUserTxCache(userId);

    return NextResponse.json({ success: true, message: "Account data wiped." });
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Account wipe failed") },
      { status: 500 }
    );
  }
}
