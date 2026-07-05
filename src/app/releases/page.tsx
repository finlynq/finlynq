import Link from "next/link";
import type { Metadata } from "next";
import { AnalyticsConsent } from "@/components/analytics-consent";
import { JsonLd, breadcrumbSchema } from "@/components/seo/json-ld";
import { RELEASES_BY_DATE } from "@/lib/seo/releases";

export const metadata: Metadata = {
  title: "Releases · Finlynq",
  description:
    "Release notes and changelog for Finlynq, the open-source personal finance app with a first-party MCP server. What's new in each version.",
  alternates: { canonical: "/releases" },
  openGraph: {
    title: "Finlynq releases",
    description:
      "Release notes and changelog for the open-source, MCP-first personal finance app.",
    url: "/releases",
    type: "website",
    siteName: "Finlynq",
  },
  twitter: {
    card: "summary_large_image",
    title: "Finlynq releases",
    description:
      "What's new in each version of the open-source, MCP-first personal finance app.",
  },
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      });
}

export default function ReleasesIndexPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <AnalyticsConsent />
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Releases", path: "/releases" },
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
          <h1 className="mt-4 text-4xl font-bold tracking-tight">Releases</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Release notes and changelog for Finlynq. Every version, what shipped,
            and why it matters. The full source-level changelog lives on{" "}
            <a
              href="https://github.com/finlynq/finlynq/releases"
              className="underline underline-offset-2 hover:text-primary"
            >
              GitHub
            </a>
            .
          </p>
        </header>

        <section className="space-y-10">
          {RELEASES_BY_DATE.map((release) => (
            <article
              key={release.slug}
              className="border-b border-border pb-10 last:border-b-0"
            >
              <h2 className="flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">
                <Link
                  href={`/releases/${release.slug}`}
                  className="hover:text-primary"
                >
                  {release.name}
                </Link>
                {release.current && (
                  <span className="rounded-full bg-primary/15 px-2.5 py-0.5 text-xs font-medium text-primary">
                    Latest
                  </span>
                )}
              </h2>
              <p className="mt-2 text-xs font-mono uppercase tracking-wider text-muted-foreground">
                {fmtDate(release.date)}
              </p>
              <p className="mt-4 text-[15px] leading-relaxed text-foreground/90">
                {release.tagline}
              </p>
              <p className="mt-4">
                <Link
                  href={`/releases/${release.slug}`}
                  className="text-sm underline underline-offset-2 hover:text-primary"
                >
                  Read the release notes →
                </Link>
              </p>
            </article>
          ))}
        </section>
      </div>
    </div>
  );
}
