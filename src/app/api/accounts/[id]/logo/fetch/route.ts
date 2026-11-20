/**
 * POST /api/accounts/[id]/logo/fetch — fetch a bank's icon from its website
 * (GH #420). Body { domain }. Returns the icon as a data URL for the browser
 * to draw onto a canvas and save through PUT /api/accounts/[id]/logo; nothing
 * is stored here.
 *
 * The domain is user input, so the fetch is SSRF-guarded (public addresses
 * only, checked in the socket's own lookup; https; capped size and time; real
 * image formats only) in lib/accounts/logo-fetch.ts. Limited to 10 a minute
 * per user. Owner check on the account so the endpoint isn't a free proxy.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";

import { db, schema } from "@/db";
import { apiHandler } from "@/lib/api-handler";
import { checkRateLimit } from "@/lib/rate-limit";
import { fetchInstitutionIcon, LogoFetchError, normalizeInstitutionDomain } from "@/lib/accounts/logo-fetch";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ domain: z.string().min(1).max(300) });

export const POST = apiHandler(
  { auth: "auth", body: bodySchema, fallbackMessage: "Couldn't fetch that logo" },
  async ({ request, userId, body }) => {
    const m = /\/api\/accounts\/(\d+)\/logo\/fetch/.exec(request.nextUrl.pathname);
    const accountId = m ? Number(m[1]) : null;
    if (accountId == null) return NextResponse.json({ error: "Account not found" }, { status: 404 });
    const owned = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.userId, userId)))
      .get();
    if (!owned) return NextResponse.json({ error: "Account not found" }, { status: 404 });

    const domain = normalizeInstitutionDomain(body.domain);
    if (!domain) {
      return NextResponse.json({ error: "Enter the bank's website, like examplebank.com." }, { status: 400 });
    }
    if (!checkRateLimit(`logo-fetch:${userId}`, 10, 60_000).allowed) {
      return NextResponse.json({ error: "Too many logo lookups. Try again in a minute." }, { status: 429 });
    }
    try {
      const icon = await fetchInstitutionIcon(domain);
      return { domain, mime: icon.mime, dataUrl: `data:${icon.mime};base64,${icon.bytes.toString("base64")}` };
    } catch (e) {
      if (e instanceof LogoFetchError) return NextResponse.json({ error: e.message }, { status: 422 });
      throw e;
    }
  },
);
