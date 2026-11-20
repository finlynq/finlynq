/**
 * /api/accounts/[id]/logo — an account's logo (GH #420, 2026-11-20).
 *
 *   GET     the PNG, same-origin (so the CSP's img-src 'self' holds and no
 *           third party is contacted on page load). 404 when there is none
 *           or the session has no key to decrypt it; the UI then shows the
 *           letter avatar.
 *   PUT     { image: "data:image/png;base64,...", source: "upload"|"domain",
 *           domain?: string } — the browser has already drawn the image onto
 *           a canvas (<=128px PNG). Needs the DEK (the image is encrypted).
 *   DELETE  remove it.
 *
 * Owner-scoped throughout (lib/accounts/logo-store.ts).
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { apiHandler } from "@/lib/api-handler";
import {
  AccountLogoError,
  decodeLogoDataUrl,
  deleteAccountLogo,
  readAccountLogo,
  saveAccountLogo,
} from "@/lib/accounts/logo-store";
import { normalizeInstitutionDomain } from "@/lib/accounts/logo-fetch";

export const dynamic = "force-dynamic";

function accountIdFrom(request: NextRequest): number | null {
  const m = /\/api\/accounts\/(\d+)\/logo/.exec(request.nextUrl.pathname);
  return m ? Number(m[1]) : null;
}

function refusal(e: unknown): NextResponse | null {
  if (!(e instanceof AccountLogoError)) return null;
  return NextResponse.json({ error: e.message }, { status: e.code === "not_found" ? 404 : 400 });
}

export const GET = apiHandler({ auth: "auth", fallbackMessage: "Failed to load logo" }, async ({ request, userId, dek }) => {
  const accountId = accountIdFrom(request);
  if (accountId == null || !dek) return new NextResponse(null, { status: 404 });
  const logo = await readAccountLogo(userId, dek, accountId);
  if (!logo) return new NextResponse(null, { status: 404 });
  return new NextResponse(new Uint8Array(logo.png), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      // Private: it identifies the user's bank. The ?v= the UI adds changes
      // whenever the logo does, so a day of caching is safe.
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
});

const putSchema = z.object({
  image: z.string().max(300_000),
  source: z.enum(["upload", "domain"]),
  domain: z.string().max(300).nullable().optional(),
});

export const PUT = apiHandler(
  { auth: "encryption", body: putSchema, fallbackMessage: "Failed to save logo" },
  async ({ request, userId, dek, body }) => {
    const accountId = accountIdFrom(request);
    if (accountId == null) return NextResponse.json({ error: "Account not found" }, { status: 404 });
    try {
      const png = decodeLogoDataUrl(body.image);
      const domain = body.source === "domain" && body.domain ? normalizeInstitutionDomain(body.domain) : null;
      const version = await saveAccountLogo(userId, dek as Buffer, accountId, png, body.source, domain);
      return { accountId, version };
    } catch (e) {
      const r = refusal(e);
      if (r) return r;
      throw e;
    }
  },
);

export const DELETE = apiHandler({ auth: "auth", fallbackMessage: "Failed to remove logo" }, async ({ request, userId }) => {
  const accountId = accountIdFrom(request);
  if (accountId == null) return NextResponse.json({ error: "Account not found" }, { status: 404 });
  return { removed: await deleteAccountLogo(userId, accountId) };
});
