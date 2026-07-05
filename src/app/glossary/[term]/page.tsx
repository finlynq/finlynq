import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AnalyticsConsent } from "@/components/analytics-consent";
import {
  JsonLd,
  articleSchema,
  breadcrumbSchema,
} from "@/components/seo/json-ld";
import { GLOSSARY_SLUGS, getGlossaryEntry } from "@/lib/seo/glossary";
import { metaDescription } from "@/lib/seo/site";

export function generateStaticParams() {
  return GLOSSARY_SLUGS.map((term) => ({ term }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ term: string }>;
}): Promise<Metadata> {
  const { term } = await params;
  const entry = getGlossaryEntry(term);
  if (!entry) return {};
  return {
    title: `${entry.term} | Finlynq glossary`,
    description: metaDescription(entry.description),
    alternates: { canonical: `/glossary/${entry.slug}` },
    openGraph: {
      title: entry.term,
      description: entry.description,
      url: `/glossary/${entry.slug}`,
      type: "article",
      siteName: "Finlynq",
    },
    twitter: {
      card: "summary_large_image",
      title: entry.term,
      description: entry.description,
    },
  };
}

export default async function GlossaryTermPage({
  params,
}: {
  params: Promise<{ term: string }>;
}) {
  const { term } = await params;
  const entry = getGlossaryEntry(term);
  if (!entry) notFound();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AnalyticsConsent />
      <JsonLd
        data={articleSchema({
          title: entry.term,
          description: entry.description,
          path: `/glossary/${entry.slug}`,
          datePublished: entry.lastUpdated,
        })}
      />
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Glossary", path: "/glossary" },
          { name: entry.shortTerm, path: `/glossary/${entry.slug}` },
        ])}
      />
      <div className="mx-auto max-w-3xl px-6 py-16">
        <header className="mb-10 border-b border-border pb-8">
          <Link
            href="/glossary"
            className="text-xs font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            ← Glossary
          </Link>
          <h1 className="mt-4 text-4xl font-bold tracking-tight">
            {entry.term}
          </h1>
          <p className="mt-5 text-lg leading-relaxed text-foreground/90">
            {entry.description}
          </p>
          <p className="mt-4 text-xs text-muted-foreground">
            Last updated: {entry.lastUpdated}
          </p>
        </header>

        <article className="prose prose-invert max-w-none space-y-5 text-[15px] leading-relaxed">
          {entry.blocks.map((block, i) => {
            if (block.type === "h2") {
              return (
                <h2 key={i} className="text-xl font-semibold mt-10 mb-3">
                  {block.text}
                </h2>
              );
            }
            if (block.type === "ul") {
              return (
                <ul key={i} className="list-disc pl-6 space-y-2">
                  {block.items.map((item, j) => (
                    <li key={j}>{item}</li>
                  ))}
                </ul>
              );
            }
            return <p key={i}>{block.text}</p>;
          })}
        </article>

        {entry.related.length > 0 && (
          <section className="mt-12">
            <h2 className="text-sm font-mono uppercase tracking-wider text-muted-foreground">
              Related
            </h2>
            <ul className="mt-3 space-y-1.5">
              {entry.related.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="text-sm underline underline-offset-2 hover:text-primary"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="mt-12 rounded-2xl border border-primary/20 bg-primary/5 p-6">
          <h2 className="text-base font-semibold text-foreground">Try Finlynq</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Open-source personal finance with a first-party MCP server. Self-host
            with Docker or use the free managed cloud. AGPL v3.
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
              href="/mcp-guide"
              className="inline-flex items-center gap-2 rounded-xl border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted/40 transition-colors"
            >
              MCP guide
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
