/**
 * GET /api/auth/verify-email?token=... — Verify email address.
 *
 * Managed edition only. Marks the user's email as verified and redirects to
 * the dashboard.
 *
 * Finding M-19 (2026-05-07) — open-redirect hardening. Previously the
 * redirect target was built directly from `process.env.APP_URL`. A
 * misconfigured or environment-injected `APP_URL` would turn this into an
 * open redirect by way of an emailed verification link. We now anchor the
 * redirect on `request.nextUrl.origin` (the origin the request actually
 * arrived at) and only honor `APP_URL` when it matches that origin exactly;
 * any mismatch is logged and the request-origin path is taken anyway.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDialect } from "@/db";
import { verifyUserEmail } from "@/lib/auth/queries";

export async function GET(request: NextRequest) {
  if (getDialect() !== "postgres") {
    return NextResponse.json(
      { error: "Email verification is only available in managed mode." },
      { status: 403 }
    );
  }

  const token = new URL(request.url).searchParams.get("token");
  if (!token) {
    return NextResponse.json(
      { error: "Missing verification token." },
      { status: 400 }
    );
  }

  const user = await verifyUserEmail(token);
  if (!user) {
    return NextResponse.json(
      { error: "Invalid or expired verification token." },
      { status: 400 }
    );
  }

  // Anchor on the request's actual origin. If APP_URL is set, validate it
  // against that origin and warn (without honoring it) on mismatch — this
  // makes a misconfigured deployment fail safe instead of redirecting users
  // to an attacker-controlled host.
  const requestOrigin = request.nextUrl.origin;
  let redirectBase = requestOrigin;
  if (process.env.APP_URL) {
    try {
      const configured = new URL(process.env.APP_URL).origin;
      if (configured === requestOrigin) {
        redirectBase = configured;
      } else {
        console.warn(
          `[verify-email] APP_URL origin (${configured}) does not match request origin (${requestOrigin}); using request origin to defend against open-redirect via misconfiguration.`
        );
      }
    } catch {
      console.warn(
        `[verify-email] APP_URL is set to an unparseable value; using request origin (${requestOrigin}) instead.`
      );
    }
  }

  return NextResponse.redirect(`${redirectBase}/dashboard?emailVerified=1`);
}
