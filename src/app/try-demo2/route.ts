/**
 * GET /try-demo2 — Zero-click auto-login as the SCRATCH test account.
 *
 * A second fixture account for manual testing, deliberately NOT advertised
 * anywhere in the product or marketing: no link, no sitemap entry, no mention
 * on /cloud. It exists so a throwaway account is always one URL away — useful
 * for exercising flows that a seeded demo can't (a fresh signup's onboarding
 * wizard, "Clear All Data", first-run empty states) without minting a new user
 * each time.
 *
 * Unlike the demo, this account starts EMPTY with `onboarding_complete = 0`, so
 * the first visit lands in the onboarding wizard. Reset it to that state at any
 * time with the app's own "Clear All Data" button on /settings/data (which
 * clears every per-user row and flips `onboarding_complete` back to 0), or
 * re-run `npx tsx scripts/seed-demo2.ts`.
 *
 * ⚠️ Its credentials are in this file, and this repo is PUBLIC — treat the
 * account as world-readable and world-writable. Never put anything in it you
 * would not publish. That is an accepted trade-off for a scratch account: it
 * holds only throwaway data, and it is wiped whenever anyone resets it.
 *
 * Like /try-demo, the account is a hardcoded constant — no `?user=` parameter
 * exists on either route, so a tweaked URL can never reach a different account.
 */

import { NextRequest } from "next/server";
import { zeroClickLogin } from "@/lib/auth/zero-click-login";

export async function GET(request: NextRequest) {
  return zeroClickLogin(request, {
    identifier: "demo2@finlynq.com",
    password: "finlynq-demo2",
    slug: "try-demo2",
    defaultNext: "/dashboard",
    seedHint: "Test account not seeded. Run `npx tsx scripts/seed-demo2.ts` first.",
  });
}
