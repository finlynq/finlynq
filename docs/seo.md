# SEO architecture

How Finlynq's public marketing surface is optimized for search engines and
AI-assistant citation. Phase 1 (technical foundations) shipped 2026-05-29.

## Single source of truth

- **[src/lib/seo/site.ts](../src/lib/seo/site.ts)** — `SITE_URL` (env-overridable
  via `NEXT_PUBLIC_SITE_URL`, defaults to `https://finlynq.com`), `STATIC_ROUTES`,
  `VS_SLUGS` + `VS_META`, `BLOG_SLUGS`, and `absoluteUrl()`. Imported by the
  sitemap, robots, the `/vs` index, and the JSON-LD builders so the URL list +
  canonical host never drift. **Add a new comparison or blog post here** and it
  flows into the sitemap, robots, and the `/vs` index automatically.

## Metadata

- **Root [layout.tsx](../src/app/layout.tsx)** sets `metadataBase`, default
  `openGraph` / `twitter`, `applicationName`, keywords, and a `viewport` export
  (Next 16 wants `themeColor` in `viewport`, NOT `metadata`). Every child page's
  relative `alternates.canonical` / `openGraph.url` resolves against
  `metadataBase` — so pages use `"/about"`, never `"https://finlynq.com/about"`.
- Each public page sets its own `title`, `description`, `alternates.canonical`,
  `openGraph`, and (where it matters) `twitter`.
- **Client-component pages can't export `metadata`.** Two patterns in the repo:
  - `/` — split into a server `page.tsx` (metadata + JSON-LD) wrapping
    `LandingClient` ([src/components/landing/landing-client.tsx](../src/components/landing/landing-client.tsx)).
  - `/cloud`, `/mcp-guide` — a sibling server `layout.tsx` holds the metadata.

## JSON-LD (structured data)

- **[src/components/seo/json-ld.tsx](../src/components/seo/json-ld.tsx)** — the
  `JsonLd` server component reads the per-request CSP nonce
  (`headers().get("x-nonce")`) and stamps it on the `<script>`. The enforced CSP
  is nonce-based with `'strict-dynamic'` and **no `'unsafe-inline'`** in
  `script-src` (see [src/middleware.ts](../src/middleware.ts)); `application/
  ld+json` data blocks are likely exempt, but we stamp the nonce anyway. **Never
  hand-write an inline `<script type="application/ld+json">`** — route it through
  `JsonLd` so it carries the nonce.
- Builders: `organizationSchema()` (mounted once in the root layout, every
  page), `softwareApplicationSchema()` (home + /about, shared `@id`),
  `articleSchema()` (blog/docs), `breadcrumbSchema()` (/vs/\*, /blog/\*, /vs),
  `faqSchema()` (/about — plain-text answers only).

## Crawl surface

- **[sitemap.ts](../src/app/sitemap.ts)** → `/sitemap.xml`. Built from `site.ts`.
- **[robots.ts](../src/app/robots.ts)** → `/robots.txt`. Allows the marketing +
  docs surface; disallows the `(app)` auth routes + `/api/`. NOTE: `/mcp` is
  anchored (`/mcp$`, `/mcp/`) so it doesn't deindex the public `/mcp-guide`.
- **[public/llms.txt](../public/llms.txt)** — curated map for AI crawlers
  (llms.txt convention). Hand-maintained; static so it hardcodes finlynq.com.
  `llms-full.txt` (long-form concat of docs) ships with the Phase 2 docs route.
- **GA / CSP `isWebsite` gate** in middleware now covers `/about`, `/blog`,
  `/mcp-guide`, `/vs`, `/docs` so analytics beacons aren't CSP-blocked there.

## Target keyword map (Phase 0)

| Query (SERP intent) | Owning page |
|---|---|
| open source personal finance / budgeting app | `/` |
| self-hosted personal finance | `/self-hosted` |
| firefly iii alternative | `/vs/firefly-iii` |
| monarch money alternative (open source) | `/vs/monarch` |
| era personal finance alternative | `/vs/era` |
| what is finlynq / finlynq vs finq | `/about` |

| Query (AI-assistant intent) | Owning page |
|---|---|
| best MCP server for personal finance | `/`, `/mcp-guide` |
| MCP server for budgeting / money | `/mcp-guide`, `/mcp-guide/tools` |
| connect Claude to my finances | `/mcp-guide` |

Capture a baseline before measuring lift: GSC impressions/clicks/position,
`site:finlynq.com` indexed count, and GA referrals from chatgpt.com /
perplexity.ai / claude.ai.

## Phase 2 — glossary + llms-full.txt (shipped 2026-05-29)

- **`/glossary` + `/glossary/<slug>`** — hand-authored, accurate definition pages
  ([src/lib/seo/glossary.ts](../src/lib/seo/glossary.ts) data → server-rendered,
  no markdown dependency). Each has Article + BreadcrumbList JSON-LD. Targets
  informational-intent queries + AI citation.
- **`/llms-full.txt`** ([route](../src/app/llms-full.txt/route.ts)) — long-form
  companion to llms.txt, built from the glossary + page pointers.
- **The public `/docs/*` markdown route is DEFERRED on purpose.** The tracked
  user docs (getting-started.md, faq.md, mobile-setup.md) are STALE — they still
  describe the obsolete SQLite/SQLCipher passphrase-wizard architecture, not the
  current PostgreSQL + username/password + per-user-DEK model. Exposing them raw
  would publish misinformation. They need a rewrite-for-current-architecture pass
  first (spawned as a separate task); then a `/docs/*` route can render them.

## Phase 3 — /vs expansion (shipped 2026-05-29)

The comparison cluster grew from 4 to 8 pages: added `/vs/ynab`, `/vs/actual`,
`/vs/ghostfolio`, `/vs/maybe`. All use the shared `VsPage` template, carry
BreadcrumbList JSON-LD (via the component), and are registered in `site.ts`
(`VS_SLUGS` + `VS_META`) so they flow into the sitemap, the `/vs` index, the
footer, and llms-full.txt. Content is sourced + dated; re-fact-check competitor
claims before any prod promotion.

## Phase 4 — OG images, IndexNow, repo SEO (shipped 2026-05-29)

- **OG / Twitter images** — sitewide [opengraph-image.tsx](../src/app/opengraph-image.tsx)
  (+ twitter-image re-export) via `next/og` ImageResponse. Next attaches it to
  every route's OG/Twitter metadata automatically. Per-page dynamic images
  (e.g. "Finlynq vs X") remain a future enhancement.
- **IndexNow** — ownership key at `public/7e2c9a4f1b6d83e05a9c2f47b1d6e803.txt`.
  After a deploy, ping Bing to index new/changed URLs:
  `curl "https://api.indexnow.org/indexnow?url=https://finlynq.com/&key=7e2c9a4f1b6d83e05a9c2f47b1d6e803"`
- **GitHub repo SEO** — repo description + topics set via `gh repo edit`
  (personal-finance, mcp, model-context-protocol, self-hosted, budgeting,
  nextjs, postgresql, agpl, …). The social-preview IMAGE must still be uploaded
  manually in repo Settings (GitHub has no API for it) — use the OG image.

## Deferred / needs user action

- **Awesome-list PRs** (awesome-selfhosted, awesome-mcp-servers ×N,
  awesome-personal-finance) and **Google Search Console / Bing Webmaster**
  verification + sitemap submission — external accounts / third-party repos,
  out of scope for an automated push. Submit `${SITE_URL}/sitemap.xml`.
- **GitHub social-preview image upload** (manual, see above).
- **`/docs/*` route** — pending the stale-doc rewrite (see Phase 2 note).
- **FAQPage JSON-LD on `/vs/*`** — blocked on the `faq` answers being JSX
  (`ReactNode`); needs a plain-text `aText` field on `FaqItem` to serialize.
