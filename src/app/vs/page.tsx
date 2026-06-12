import Link from "next/link";
import type { Metadata } from "next";
import { AnalyticsConsent } from "@/components/analytics-consent";
import { JsonLd, breadcrumbSchema } from "@/components/seo/json-ld";
import { VS_SLUGS, VS_META } from "@/lib/seo/site";

export const metadata: Metadata = {
  title: "Finlynq vs other personal finance apps — side-by-side comparisons",
  description:
    "How Finlynq compares to Monarch Money, Era, Firefly III, and Alderfi: open-source AGPL v3, self-hostable, first-party MCP server, and per-user envelope encryption versus each alternative. Honest side-by-side tables, when to choose each, and migration steps.",
  alternates: { canonical: "/vs" },
  openGraph: {
    title: "Finlynq vs other personal finance apps",
    description:
      "Side-by-side comparisons of Finlynq against Monarch, Era, Firefly III, and Alderfi.",
    url: "/vs",
    type: "website",
    siteName: "Finlynq",
  },
  twitter: {
    card: "summary_large_image",
    title: "Finlynq vs other personal finance apps",
    description:
      "Open-source, self-hostable, MCP-first PFM compared with Monarch, Era, Firefly III, and Alderfi.",
  },
};

export default function VsIndexPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <AnalyticsConsent />
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Comparisons", path: "/vs" },
        ])}
      />
      <div className="mx-auto max-w-3xl px-6 py-16">
        <header className="mb-12 border-b border-border pb-8">
          <Link
            href="/"
            className="text-xs font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            ← Finlynq
          </Link>
          <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-border bg-muted/40 px-3 py-1 text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
            Comparisons
          </div>
          <h1 className="mt-4 text-4xl font-bold tracking-tight">
            Finlynq vs other personal finance apps
          </h1>
          <p className="mt-4 text-base leading-relaxed text-muted-foreground">
            Honest, sourced side-by-side comparisons. Finlynq is open-source
            (AGPL v3), self-hostable, and the only personal finance manager with
            a shipped first-party MCP server and per-user envelope encryption.
          </p>
        </header>

        <section className="space-y-4">
          {VS_SLUGS.map((slug) => (
            <Link
              key={slug}
              href={`/vs/${slug}`}
              className="block rounded-xl border border-border bg-card p-5 transition-colors hover:border-primary/40 hover:bg-muted/30"
            >
              <h2 className="text-lg font-semibold tracking-tight">
                Finlynq vs {VS_META[slug].name}
              </h2>
              <p className="mt-1.5 text-sm text-muted-foreground">
                {VS_META[slug].blurb}
              </p>
            </Link>
          ))}
        </section>

        <div className="mt-12 rounded-2xl border border-primary/20 bg-primary/5 p-6">
          <h3 className="text-base font-semibold text-foreground">Try Finlynq</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Free, open source, AGPL v3. Run it on our managed cloud or self-host
            with one Docker Compose file. Same features either way.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link
              href="/cloud?tab=register"
              className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Try the managed cloud
              <span aria-hidden="true">→</span>
            </Link>
            <Link
              href="/try-demo?next=/dashboard"
              className="inline-flex items-center gap-2 rounded-xl border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted/40 transition-colors"
            >
              Try the live demo (no signup)
            </Link>
            <Link
              href="/self-hosted"
              className="inline-flex items-center gap-2 rounded-xl border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted/40 transition-colors"
            >
              Self-host with Docker
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
