import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AnalyticsConsent } from "@/components/analytics-consent";
import { StoreBadges } from "@/components/store-badges";
import {
  JsonLd,
  articleSchema,
  breadcrumbSchema,
} from "@/components/seo/json-ld";
import { RELEASE_SLUGS, getRelease } from "@/lib/seo/releases";
import { metaDescription } from "@/lib/seo/site";

export function generateStaticParams() {
  return RELEASE_SLUGS.map((version) => ({ version }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ version: string }>;
}): Promise<Metadata> {
  const { version } = await params;
  const release = getRelease(version);
  if (!release) return {};
  const title = `${release.name} release notes`;
  return {
    title: `${title} · Finlynq`,
    description: metaDescription(release.tagline),
    alternates: { canonical: `/releases/${release.slug}` },
    openGraph: {
      title,
      description: release.tagline,
      url: `/releases/${release.slug}`,
      type: "article",
      siteName: "Finlynq",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: release.tagline,
    },
  };
}

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

export default async function ReleaseNotesPage({
  params,
}: {
  params: Promise<{ version: string }>;
}) {
  const { version } = await params;
  const release = getRelease(version);
  if (!release) notFound();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AnalyticsConsent />
      <JsonLd
        data={articleSchema({
          title: `${release.name} release notes`,
          description: release.tagline,
          path: `/releases/${release.slug}`,
          datePublished: release.date,
        })}
      />
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Releases", path: "/releases" },
          { name: release.name, path: `/releases/${release.slug}` },
        ])}
      />
      <div className="mx-auto max-w-3xl px-6 py-16">
        <header className="mb-10 border-b border-border pb-8">
          <Link
            href="/releases"
            className="text-xs font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            ← All releases
          </Link>
          <h1 className="mt-4 flex flex-wrap items-center gap-3 text-4xl font-bold tracking-tight">
            {release.name}
            {release.current && (
              <span className="rounded-full bg-primary/15 px-2.5 py-0.5 text-sm font-medium text-primary">
                Latest
              </span>
            )}
          </h1>
          <p className="mt-4 text-xs font-mono uppercase tracking-wider text-muted-foreground">
            Released {fmtDate(release.date)}
          </p>
          {release.summary.map((para, i) => (
            <p
              key={i}
              className="mt-5 text-lg leading-relaxed text-foreground/90"
            >
              {para}
            </p>
          ))}
        </header>

        <article className="space-y-10">
          {release.sections.map((section) => (
            <section key={section.heading}>
              <h2 className="text-xl font-semibold tracking-tight">
                {section.heading}
              </h2>
              <ul className="mt-3 list-disc space-y-2 pl-6 text-[15px] leading-relaxed text-foreground/90">
                {section.items.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </section>
          ))}
        </article>

        <section className="mt-12 rounded-2xl border border-primary/20 bg-primary/5 p-6">
          <h2 className="text-base font-semibold text-foreground">
            Get Finlynq {release.version}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Finlynq is free and open source (AGPL v3). Self-host with Docker or
            use the free managed cloud. The mobile app is on both stores.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link
              href="/cloud?tab=register"
              className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Try the managed cloud
              <span aria-hidden="true">→</span>
            </Link>
            <a
              href={release.githubUrl}
              className="inline-flex items-center gap-2 rounded-xl border border-border bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/40"
            >
              Full release on GitHub
            </a>
          </div>
          <div className="mt-5">
            <StoreBadges />
          </div>
        </section>
      </div>
    </div>
  );
}
