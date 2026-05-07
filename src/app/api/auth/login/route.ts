/**
 * POST /api/auth/login — Authenticate with username-or-email + password
 * (managed edition).
 *
 * The `identifier` field accepts either a username or an email. Legacy
 * clients sending `{email, password}` are still supported via a Zod union —
 * email-shaped identifiers route through the same getUserByIdentifier path.
 *
 * If MFA is enabled, returns { mfaRequired: true } instead of a session.
 * The client must then call /api/auth/mfa/verify with the TOTP code.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { getDialect } from "@/db";
import {
  verifyPassword,
  createSessionToken,
  AUTH_COOKIE,
} from "@/lib/auth";

/**
 * Finding H-3 (2026-05-07) — fixed-cost bcrypt comparison target used when
 * the supplied identifier doesn't match any user. Without this, login takes
 * ~150ms for a known username (bcrypt verify against the real hash) but ~1ms
 * for an unknown one (we short-circuit on lookup) — a wall-clock oracle that
 * leaks which identifiers exist. The dummy hash is generated once at module
 * load with the same cost factor as `hashPassword`, so the bcrypt-compare
 * branch we walk in the !user case has the same CPU profile as the success
 * path. The plaintext is a fixed string nobody could ever submit; it is
 * never compared against anything that could match.
 */
const DUMMY_BCRYPT_HASH = bcrypt.hashSync(
  "never-actually-matched-anything",
  12
);
import { SESSION_TTL_MS } from "@/lib/auth/jwt";
import {
  getUserByIdentifier,
  recordSuccessfulLogin,
  promoteUserToEncryption,
} from "@/lib/auth/queries";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import { checkRateLimit } from "@/lib/rate-limit";
import { deriveKEK, unwrapDEK, createWrappedDEKForPassword } from "@/lib/crypto/envelope";
import { putDEK } from "@/lib/crypto/dek-cache";
// Stream D Phase 4 (2026-05-03): plaintext display-name columns dropped.
// `stream-d-backfill` (encrypts plaintext into ct) and
// `stream-d-phase3-null` (NULLs plaintext after backfill) are obsolete with
// no plaintext source; both helpers were deleted.
import { enqueueCanonicalizePortfolioNames } from "@/lib/crypto/stream-d-canonicalize-portfolio";
import { enqueueUpgradeStagingEncryption } from "@/lib/email-import/upgrade-staging-encryption";

// Accept either {identifier, password} (preferred) OR {email, password}
// (legacy clients). Both shapes normalise to an `identifier` string.
const loginSchema = z
  .object({
    identifier: z.string().min(1, "Username or email is required").max(254).optional(),
    email: z.string().min(1).max(254).optional(),
    password: z.string().min(1, "Password is required").max(256),
  })
  .transform((v) => ({
    identifier: (v.identifier ?? v.email ?? "").trim(),
    password: v.password,
  }))
  .refine((v) => v.identifier.length > 0, {
    message: "Username or email is required",
    path: ["identifier"],
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

    const { identifier, password } = parsed.data;

    // Finding #11 — also rate-limit per identifier (10/hour, 50/day). Stops a
    // distributed attacker from grinding one account via a botnet. The
    // key is normalised lowercase so "Foo" and "foo" share the bucket.
    // Error message is identical to the per-IP limit so attackers can't
    // use the response to enumerate which usernames/emails exist.
    const idKey = identifier.toLowerCase();
    const idHourly = checkRateLimit(`login:id:h:${idKey}`, 10, 60 * 60 * 1000);
    const idDaily = checkRateLimit(`login:id:d:${idKey}`, 50, 24 * 60 * 60 * 1000);
    if (!idHourly.allowed || !idDaily.allowed) {
      const resetAt = Math.max(
        idHourly.allowed ? 0 : idHourly.resetAt,
        idDaily.allowed ? 0 : idDaily.resetAt
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
      { error: "Invalid username or password." },
      { status: 401 }
    );

    const user = await getUserByIdentifier(identifier);
    if (!user) {
      // Finding H-3 — pay the bcrypt cost even when the user is missing so
      // wall-clock timing doesn't leak whether the identifier exists. The
      // result of this compare is intentionally discarded; the cost is the
      // point. Returning before this would shave ~150ms off the response
      // and turn login into a username-enumeration oracle.
      await verifyPassword(password, DUMMY_BCRYPT_HASH);
      return invalidCredentials;
    }

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
    // B7: the pending token carries `pending: true` and a 5-minute TTL.
    // The default account strategy rejects pending tokens for every route
    // except /api/auth/mfa/verify so a captured pending cookie can't access
    // dashboards or transactions (finding H-4). On successful MFA verify the
    // pending jti is INSERTed into `revoked_jtis` so the token can't be
    // replayed against /mfa/verify either.
    // The DEK is cached under the pending jti with a matching 5-minute TTL so
    // MFA verify can promote it to the real session without asking the user
    // to re-enter their password. If MFA verify fails or times out, the entry
    // ages out naturally.
    if (user.mfaEnabled) {
      const { token: pendingToken, jti: pendingJti } = await createSessionToken(
        user.id,
        false,
        { pending: true, expirationTime: "5m" }
      );
      if (dek) putDEK(pendingJti, dek, 5 * 60_000, user.id);
      return NextResponse.json({
        mfaRequired: true,
        mfaPendingToken: pendingToken,
      });
    }

    // No MFA — issue full session and cache the DEK under this session's jti.
    await recordSuccessfulLogin(user.id);
    const { token, jti } = await createSessionToken(user.id, false);
    if (dek) {
      putDEK(jti, dek, SESSION_TTL_MS, user.id);
      // Stream D Phase 4 (2026-05-03): plaintext columns are gone, so the
      // backfill + phase-3-null helpers no longer run on login. Only the
      // per-user lazy canonicalization remains — it now reads `name_ct` /
      // `symbol_ct` directly and rewrites tickered / cash / currency-code
      // holdings' names to canonical form (uppercased symbol, "Cash",
      // "Cash <CCY>"). User-defined positions keep their free-text name.
      // Bails silently for DEK-mismatch users — sample-decrypt precondition.
      enqueueCanonicalizePortfolioNames(user.id, dek);
      // Service→user staging-row encryption upgrade (2026-05-06). Flips this
      // user's pending email-staged rows from PF_STAGING_KEY to user-DEK so
      // the 60-day window isn't service-key-decryptable for active users.
      // Idempotent, fire-and-forget, errors swallowed.
      enqueueUpgradeStagingEncryption(user.id, dek);
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
