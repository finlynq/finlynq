import type { MetadataRoute } from "next";

/**
 * Public sitemap for finlynq.com.
 *
 * Only lists routes outside the `(app)` auth group — anything that requires a
 * Finlynq login is intentionally excluded. The list is also pre-filter for AI
 * crawlers / LLM citation: every URL here is a route an unauthenticated user
 * (or a search bot) can actually reach without 401-ing.
 *
 * When adding a new `/vs/<slug>` page, add the slug to `VS_SLUGS`.
 */

const BASE_URL = "https://finlynq.com";

const VS_SLUGS = ["era", "firefly-iii", "alderfi"] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  const staticRoutes: MetadataRoute.Sitemap = [
    {
      url: `${BASE_URL}/`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 1.0,
    },
    {
      url: `${BASE_URL}/cloud`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/self-hosted`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/mcp-guide`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/privacy`,
      lastModified: now,
      changeFrequency: "yearly",
      priority: 0.4,
    },
    {
      url: `${BASE_URL}/terms`,
      lastModified: now,
      changeFrequency: "yearly",
      priority: 0.4,
    },
  ];

  const vsRoutes: MetadataRoute.Sitemap = VS_SLUGS.map((slug) => ({
    url: `${BASE_URL}/vs/${slug}`,
    lastModified: now,
    changeFrequency: "monthly" as const,
    priority: 0.7,
  }));

  return [...staticRoutes, ...vsRoutes];
}
