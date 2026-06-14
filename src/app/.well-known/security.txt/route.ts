/**
 * GET /.well-known/security.txt
 *
 * RFC 9116 security contact file. The `Expires` field is computed dynamically
 * (now + 6 months) so it never goes stale regardless of deploy cadence.
 */

import { NextResponse } from "next/server";
import { SITE_URL } from "@/lib/seo/site";

export async function GET() {
  // Expires: now + 6 months, RFC 3339 / ISO 8601 with Z suffix.
  const expires = new Date();
  expires.setMonth(expires.getMonth() + 6);
  const expiresStr = expires.toISOString().replace(/\.\d{3}Z$/, "Z");

  const body = [
    "Contact: mailto:security@finlynq.com",
    `Expires: ${expiresStr}`,
    `Policy: https://github.com/finlynq/finlynq/blob/main/SECURITY.md`,
    `Canonical: ${SITE_URL}/.well-known/security.txt`,
    "Preferred-Languages: en",
    "",
  ].join("\n");

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
