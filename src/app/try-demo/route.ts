/**
 * GET /try-demo — Zero-click auto-login as the public demo user.
 *
 * Click a link from a blog post / Reddit thread / LinkedIn share and land
 * directly inside the demo app at whatever screen the marketing URL points
 * at — no typing the published credentials manually.
 *
 * Safety: the account is a HARDCODED constant below. This route does not
 * accept an identifier as a parameter, so there is no way for a tweaked URL to
 * grant access to a different account. The demo credentials are intentionally
 * public (see CLAUDE.md "Prod and demo coexist on one Postgres DB") and the
 * demo user owns only fixture data that's wiped nightly; removing the typing
 * step has no privacy impact.
 *
 * The prefetch guard, `?next=` validation, rate limiting, DEK unwrap and
 * session issuance all live in the shared `zeroClickLogin` helper, which
 * `/try-demo2` also uses.
 */

import { NextRequest } from "next/server";
import { zeroClickLogin } from "@/lib/auth/zero-click-login";

export async function GET(request: NextRequest) {
  return zeroClickLogin(request, {
    identifier: "demo@finlynq.com",
    password: "finlynq-demo",
    slug: "try-demo",
    // Default landing screen when no ?next= is supplied. Picks /dashboard so
    // first-time visitors see the at-a-glance net-worth + spending overview
    // that anchors the app, rather than dropping straight into a workflow
    // surface. Marketing links that want to showcase a specific feature
    // (e.g. the pre-staged batch from scripts/seed-demo-pending-import.ts)
    // should pass ?next=/import/pending explicitly.
    defaultNext: "/dashboard",
    seedHint: "Demo user not seeded. Run `npx tsx scripts/seed-demo.ts` first.",
  });
}
