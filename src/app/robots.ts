import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/seo/site";

/**
 * robots.txt for finlynq.com.
 *
 * Allows the public marketing + docs surface; disallows the `(app)` auth
 * routes (login-walled, no SEO value) and the API. NOTE: `/mcp` is anchored
 * with `$` so it does NOT also block the public `/mcp-guide` page — a bare
 * `/mcp` prefix would deindex the guide. `/mcp` itself 308-redirects to
 * `/api/mcp` (see next.config.ts), which is covered by `/api/`.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/api/",
          "/oauth/",
          "/try-demo",
          "/dashboard",
          "/transactions",
          "/portfolio",
          "/accounts",
          "/budgets",
          "/goals",
          "/loans",
          "/subscriptions",
          "/categories",
          "/rules",
          "/import",
          "/reconcile",
          "/inbox",
          "/settings",
          "/mcp$",
          "/mcp/",
        ],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
