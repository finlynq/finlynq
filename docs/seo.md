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

## Deferred (follow-up phases)

- **OG/Twitter images** — `opengraph-image.tsx` via `next/og` (no image files
  shipped yet; cards currently carry title + description only).
- **Phase 2** — public `/docs/*` route + glossary + `llms-full.txt`.
- **Phase 3** — new `/vs/*` competitor pages (YNAB, Actual, Ghostfolio, …).
- **Phase 4** — off-page: GitHub repo topics + social preview, awesome-list PRs,
  GSC / Bing submission, IndexNow.
- **FAQPage JSON-LD on `/vs/*`** — blocked on the `faq` answers being JSX
  (`ReactNode`); needs a plain-text `aText` field on `FaqItem` to serialize.
