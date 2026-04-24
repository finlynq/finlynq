/**
 * POST /api/auth/login — Authenticate with email/password (managed edition).
 *
 * If MFA is enabled, returns { mfaRequired: true } instead of a session.
 * The client must then call /api/auth/mfa/verify with the TOTP code.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDialect } from "@/db";
import {
  verifyPassword,
  createSessionToken,
  AUTH_COOKIE,
} from "@/lib/auth";
import { SESSION_TTL_MS } from "@/lib/auth/jwt";
import { getUserByEmail, recordSuccessfulLogin, promoteUserToEncryption } from "@/lib/auth/queries";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import { checkRateLimit } from "@/lib/rate-limit";
import { deriveKEK, unwrapDEK, createWrappedDEKForPassword } from "@/lib/crypto/envelope";
import { putDEK } from "@/lib/crypto/dek-cache";
import { enqueueStreamDBackfill } from "@/lib/crypto/stream-d-backfill";

const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

export async function POST(request: NextRequest) {
  if (getDialect() !== "postgres") {
    return NextResponse.json(
      { error: "Account login is only available in managed mode. Use passphrase unlock for self-hosted." },
      { status: 403 }
    );
  }

  // Rate limit: 5 attempts per 60 seconds per IP
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const ipLimit = checkRateLimit(`login:${ip}`, 5, 60_000);
  if (!ipLimit.allowed) {
    return NextResponse.json(
      { error: "Too many login attempts. Please try again later." },
      {
        status: 429,
        headers: {
          "Retry-After": String(
            Math.ceil((ipLimit.resetAt - Date.now()) / 1000)
          ),
        },
      }
    );
  }

  try {
    const body = await request.json();
    const parsed = validateBody(body, loginSchema);
    if (parsed.error) return parsed.error;

    const { email, password } = parsed.data;

    // Finding #11 — also rate-limit per email (10/hour, 50/day). Stops a
    // distributed attacker from grinding one account via a botnet. The
    // key is normalised lowercase so "X@Y" and "x@y" share the bucket.
    // Error message is identical to the per-IP limit so attackers can't
    // use the response to enumerate which emails exist.
    const emailKey = email.toLowerCase().trim();
    const emailHourly = checkRateLimit(`login:email:h:${emailKey}`, 10, 60 * 60 * 1000);
    const emailDaily = checkRateLimit(`login:email:d:${emailKey}`, 50, 24 * 60 * 60 * 1000);
    if (!emailHourly.allowed || !emailDaily.allowed) {
      const resetAt = Math.max(
        emailHourly.allowed ? 0 : emailHourly.resetAt,
        emailDaily.allowed ? 0 : emailDaily.resetAt
      );
      return NextResponse.json(
        { error: "Too many login attempts. Please try again later." },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.ceil((resetAt - Date.now()) / 1000)),
          },
        }
      );
    }

    // Generic error to prevent user enumeration
    const invalidCredentials = NextResponse.json(
      { error: "Invalid email or password." },
      { status: 401 }
    );

    const user = await getUserByEmail(email);
    if (!user) return invalidCredentials;

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) return invalidCredentials;

    // Derive KEK from the plaintext password, unwrap the DEK. Failure here
    // with a matching bcrypt hash would indicate a corrupted DEK envelope
    // (migration bug, not an attack) — treat as fatal and surface to caller.
    let dek: Buffer | null = null;
    if (user.kekSalt && user.dekWrapped && user.dekWrappedIv && user.dekWrappedTag) {
      try {
        const kek = deriveKEK(password, Buffer.from(user.kekSalt, "base64"));
        dek = unwrapDEK(kek, {
          salt: Buffer.from(user.kekSalt, "base64"),
          wrapped: Buffer.from(user.dekWrapped, "base64"),
          iv: Buffer.from(user.dekWrappedIv, "base64"),
          tag: Buffer.from(user.dekWrappedTag, "base64"),
        });
      } catch (err) {
        await logApiError("POST", "/api/auth/login (unwrap)", err);
        return NextResponse.json(
          { error: "Unable to unlock your encrypted data. Please contact support." },
          { status: 500 }
        );
      }
    } else {
      // Grace migration: pre-encryption account. bcrypt just verified the
      // password, so derive KEK right now, generate a fresh DEK, persist the
      // envelope, and proceed as if the account had always been encrypted.
      // Existing plaintext rows keep working because decryptField passes
      // through values without the `v1:` prefix.
      try {
        const { dek: newDek, wrapped } = createWrappedDEKForPassword(password);
        await promoteUserToEncryption(user.id, {
          kekSalt: wrapped.salt.toString("base64"),
          dekWrapped: wrapped.wrapped.toString("base64"),
          dekWrappedIv: wrapped.iv.toString("base64"),
          dekWrappedTag: wrapped.tag.toString("base64"),
        });
        dek = newDek;
      } catch (err) {
        await logApiError("POST", "/api/auth/login (promote)", err);
        // Proceed without DEK — encrypted-column routes will 423. Non-critical.
      }
    }

    // If MFA is enabled, return a pending state (no session yet).
    // The DEK is cached under the pending jti with a 5-minute TTL so MFA
    // verify can promote it to the real session without asking the user to
    // re-enter their password. If MFA verify fails or times out, the entry
    // ages out naturally.
    if (user.mfaEnabled) {
      const { token: pendingToken, jti: pendingJti } = await createSessionToken(
        user.id,
        email,
        false
      );
      if (dek) putDEK(pendingJti, dek, 5 * 60_000);
      return NextResponse.json({
        mfaRequired: true,
        mfaPendingToken: pendingToken,
      });
    }

    // No MFA — issue full session and cache the DEK under this session's jti.
    await recordSuccessfulLogin(user.id);
    const { token, jti } = await createSessionToken(user.id, email, false);
    if (dek) {
      putDEK(jti, dek, SESSION_TTL_MS);
      // Stream D: kick off a fire-and-forget pass over any un-encrypted
      // display names for this user. Typical user = <200 rows = a few ms.
      // Do NOT await — login path stays fast; backfill errors are swallowed.
      enqueueStreamDBackfill(user.id, dek);
    }

    const response = NextResponse.json({ success: true });

    response.cookies.set(AUTH_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24, // 24 hours
      path: "/",
    });

    return response;
  } catch (error) {
    await logApiError("POST", "/api/auth/login", error);
    return NextResponse.json(
      { error: safeErrorMessage(error, "Login failed") },
      { status: 500 }
    );
  }
}
