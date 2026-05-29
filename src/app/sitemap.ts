import type { MetadataRoute } from "next";
import { SITE_URL, STATIC_ROUTES, VS_SLUGS, BLOG_SLUGS } from "@/lib/seo/site";
import { GLOSSARY_SLUGS } from "@/lib/seo/glossary";

/**
 * Public sitemap for finlynq.com.
 *
 * The URL list is sourced from `src/lib/seo/site.ts` so it stays in one place
 * (shared with `robots.ts` and the `/vs` index). Only routes outside the
 * `(app)` auth group appear — every URL here is reachable by an
 * unauthenticated user or a search / LLM crawler without 401-ing.
 *
 * When adding a `/vs/<slug>` or blog post, add the slug to the lists in
 * `src/lib/seo/site.ts` — it flows here, into robots, and into the /vs index.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  const staticRoutes: MetadataRoute.Sitemap = STATIC_ROUTES.map((r) => ({
    url: `${SITE_URL}${r.path}`,
    lastModified: now,
    changeFrequency: r.changeFrequency,
    priority: r.priority,
  }));

  const vsRoutes: MetadataRoute.Sitemap = VS_SLUGS.map((slug) => ({
    url: `${SITE_URL}/vs/${slug}`,
    lastModified: now,
    changeFrequency: "monthly" as const,
    priority: 0.7,
  }));

  const blogRoutes: MetadataRoute.Sitemap = BLOG_SLUGS.map((slug) => ({
    url: `${SITE_URL}/blog/${slug}`,
    lastModified: now,
    changeFrequency: "yearly" as const,
    priority: 0.5,
  }));

  const glossaryRoutes: MetadataRoute.Sitemap = GLOSSARY_SLUGS.map((slug) => ({
    url: `${SITE_URL}/glossary/${slug}`,
    lastModified: now,
    changeFrequency: "monthly" as const,
    priority: 0.5,
  }));

  return [...staticRoutes, ...vsRoutes, ...blogRoutes, ...glossaryRoutes];
}
