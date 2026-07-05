/**
 * Single source of truth for the public site origin + the set of public,
 * crawlable routes. Imported by `sitemap.ts`, `robots.ts`, the `/vs` index,
 * and the JSON-LD schema builders so the canonical host + URL list never drift.
 *
 * SITE_URL is env-overridable so AGPL self-hosters can point canonical / OG
 * tags at their own domain instead of finlynq.com. Defaults to the managed
 * cloud origin. NEXT_PUBLIC_ so it inlines into client + metadata at build.
 */
export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "https://finlynq.com";

/**
 * Clamp a string to a search-engine-friendly `<meta name="description">`
 * length. Bing/Google truncate past ~160 chars and flag over-long descriptions,
 * so content-derived descriptions (glossary answers, release taglines) are run
 * through this before being used as the primary `description`. Truncates on a
 * word boundary and appends an ellipsis; leaves short strings untouched.
 */
export function metaDescription(text: string, max = 157): string {
  const s = text.replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 60 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Comparison pages under `/vs/<slug>`. Add a slug here when you ship a new
 * comparison page. It flows into the sitemap, the `/vs` index, and llms.txt.
 */
export const VS_SLUGS = [
  "monarch",
  "ynab",
  "era",
  "firefly-iii",
  "actual",
  "ghostfolio",
  "maybe",
  "alderfi",
] as const;
export type VsSlug = (typeof VS_SLUGS)[number];

/** One-line positioning per comparison, rendered on the `/vs` index. */
export const VS_META: Record<VsSlug, { name: string; blurb: string }> = {
  monarch: {
    name: "Monarch Money",
    blurb:
      "Open-source self-hostable vs a polished closed-source SaaS with mature US bank sync.",
  },
  ynab: {
    name: "YNAB",
    blurb:
      "Open-source with investments, multi-currency, and a first-party MCP vs closed zero-based budgeting SaaS.",
  },
  era: {
    name: "Era",
    blurb:
      "Two MCP-first personal finance apps: open-source and self-hostable vs closed hosted SaaS.",
  },
  "firefly-iii": {
    name: "Firefly III",
    blurb:
      "Two open-source self-hostable PFMs: first-party MCP and name encryption vs mature double-entry.",
  },
  actual: {
    name: "Actual Budget",
    blurb:
      "Two open-source PFMs: Actual's local-first budgeting vs Finlynq's investments, multi-currency, and MCP.",
  },
  ghostfolio: {
    name: "Ghostfolio",
    blurb:
      "A full personal-finance app with a first-party MCP vs a dedicated open-source portfolio tracker.",
  },
  maybe: {
    name: "Maybe / Sure",
    blurb:
      "Actively-built, encrypted, MCP-first vs the open-sourced-after-shutdown Maybe and its Sure fork.",
  },
  alderfi: {
    name: "Alderfi",
    blurb: "Shipped, encrypted, MCP-first Finlynq compared with Alderfi.",
  },
};

/** Published blog posts. Convert to a generated list once there is >1. */
export const BLOG_SLUGS = [
  "finlynq-mobile-app",
  "how-finlynq-encrypts-your-money",
] as const;

export type StaticRoute = {
  path: string;
  changeFrequency: "weekly" | "monthly" | "yearly";
  priority: number;
};

/**
 * Public top-level routes that live OUTSIDE the `(app)` auth group. Anything
 * requiring a Finlynq login is intentionally excluded. Every URL here is
 * reachable by an unauthenticated user or a search / LLM crawler.
 */
export const STATIC_ROUTES: StaticRoute[] = [
  { path: "/", changeFrequency: "weekly", priority: 1.0 },
  { path: "/about", changeFrequency: "monthly", priority: 0.8 },
  { path: "/cloud", changeFrequency: "monthly", priority: 0.7 },
  { path: "/self-hosted", changeFrequency: "monthly", priority: 0.8 },
  { path: "/mcp-guide", changeFrequency: "monthly", priority: 0.8 },
  { path: "/mcp-guide/tools", changeFrequency: "monthly", priority: 0.6 },
  { path: "/vs", changeFrequency: "monthly", priority: 0.6 },
  { path: "/glossary", changeFrequency: "monthly", priority: 0.5 },
  { path: "/blog", changeFrequency: "weekly", priority: 0.6 },
  { path: "/releases", changeFrequency: "weekly", priority: 0.6 },
  { path: "/roadmap", changeFrequency: "weekly", priority: 0.6 },
  { path: "/privacy", changeFrequency: "yearly", priority: 0.4 },
  { path: "/terms", changeFrequency: "yearly", priority: 0.4 },
  { path: "/account-deletion", changeFrequency: "yearly", priority: 0.3 },
];

/** Resolve a path (relative or absolute) to an absolute URL on SITE_URL. */
export function absoluteUrl(path: string): string {
  if (path.startsWith("http")) return path;
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}
