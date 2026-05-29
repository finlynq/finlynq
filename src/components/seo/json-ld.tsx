import { headers } from "next/headers";
import { SITE_URL, absoluteUrl } from "@/lib/seo/site";

/**
 * Server component that emits a JSON-LD `<script>` carrying the per-request
 * CSP nonce (set by middleware as `x-nonce`).
 *
 * The app's enforced CSP is nonce-based with `'strict-dynamic'` and NO
 * `'unsafe-inline'` in `script-src` (see src/middleware.ts). `type="application/
 * ld+json"` data blocks are likely exempt (the browser never executes them as
 * script), but we stamp the nonce anyway — belt and suspenders, and free: the
 * root layout already reads `headers()` so the whole app is dynamically
 * rendered regardless.
 */
export async function JsonLd({ data }: { data: object }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <script
      type="application/ld+json"
      nonce={nonce}
      // Structured data is server-built from literals — no user input.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}

const ORG_ID = `${SITE_URL}/#organization`;
const SOFTWARE_ID = `${SITE_URL}/#software`;

/** Organization entity. Mounted once in the root layout (every page). */
export function organizationSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": ORG_ID,
    name: "Finlynq",
    url: `${SITE_URL}/`,
    logo: `${SITE_URL}/favicon.svg`,
    description:
      "Open-source (AGPL v3) personal finance app with a first-party Model Context Protocol (MCP) server.",
    sameAs: [
      "https://github.com/finlynq/finlynq",
      "https://github.com/sponsors/finlynq",
      "https://ko-fi.com/finlynq",
    ],
  };
}

/**
 * SoftwareApplication entity. Shares its `@id` with the inline graph on
 * /about so Google treats them as one entity. `offers.price: "0"` matches the
 * existing /about convention (free + donation-supported).
 */
export function softwareApplicationSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "@id": SOFTWARE_ID,
    name: "Finlynq",
    applicationCategory: "FinanceApplication",
    applicationSubCategory: "Personal Finance",
    operatingSystem: "Web, Linux, macOS, Windows, iOS, Android",
    url: `${SITE_URL}/`,
    description:
      "Open-source (AGPL v3) personal finance web app with a first-party Model Context Protocol (MCP) server. Track income, expenses, budgets, investments, loans, and goals; query in natural language from Claude, Cursor, Windsurf, or any MCP-compatible AI assistant.",
    license: "https://www.gnu.org/licenses/agpl-3.0.html",
    sameAs: ["https://github.com/finlynq/finlynq"],
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      description: "Free and open source. Donation-supported.",
    },
    publisher: { "@id": ORG_ID },
  };
}

/** Article / BlogPosting entity for blog + docs pages. */
export function articleSchema(opts: {
  title: string;
  description: string;
  path: string;
  datePublished: string;
  dateModified?: string;
}) {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: opts.title,
    description: opts.description,
    mainEntityOfPage: { "@type": "WebPage", "@id": absoluteUrl(opts.path) },
    datePublished: opts.datePublished,
    dateModified: opts.dateModified ?? opts.datePublished,
    author: { "@type": "Organization", name: "Finlynq", url: `${SITE_URL}/` },
    publisher: { "@id": ORG_ID },
  };
}

/** BreadcrumbList entity for nested pages (/vs/*, /blog/*, etc.). */
export function breadcrumbSchema(items: { name: string; path: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: it.name,
      item: absoluteUrl(it.path),
    })),
  };
}

/** FAQPage entity. Answers must be plain text (no JSX) per schema.org. */
export function faqSchema(items: { q: string; a: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map(({ q, a }) => ({
      "@type": "Question",
      name: q,
      acceptedAnswer: { "@type": "Answer", text: a },
    })),
  };
}
