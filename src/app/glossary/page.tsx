import Link from "next/link";
import type { Metadata } from "next";
import { AnalyticsConsent } from "@/components/analytics-consent";
import { JsonLd, breadcrumbSchema } from "@/components/seo/json-ld";
import { GLOSSARY } from "@/lib/seo/glossary";

export const metadata: Metadata = {
  title: "Glossary: personal finance, MCP & encryption terms | Finlynq",
  description:
    "Plain-English definitions of the concepts behind Finlynq: MCP servers, envelope encryption, zero-knowledge finance, self-hosting, and lot-tracked cost basis.",
  alternates: { canonical: "/glossary" },
  openGraph: {
    title: "Finlynq glossary",
    description:
      "Plain-English definitions: MCP servers, envelope encryption, zero-knowledge personal finance, self-hosting, lot-tracked cost basis.",
    url: "/glossary",
    type: "website",
    siteName: "Finlynq",
  },
  twitter: {
    card: "summary_large_image",
    title: "Finlynq glossary",
    description:
      "Plain-English definitions of MCP, envelope encryption, zero-knowledge finance, and more.",
  },
};

export default function GlossaryIndexPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <AnalyticsConsent />
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Glossary", path: "/glossary" },
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
            Glossary
          </div>
          <h1 className="mt-4 text-4xl font-bold tracking-tight">Glossary</h1>
          <p className="mt-4 text-base leading-relaxed text-muted-foreground">
            Plain-English definitions of the concepts behind Finlynq, the open-
            source, MCP-first, end-to-end-encrypted personal finance app.
          </p>
        </header>

        <section className="space-y-4">
          {GLOSSARY.map((entry) => (
            <Link
              key={entry.slug}
              href={`/glossary/${entry.slug}`}
              className="block rounded-xl border border-border bg-card p-5 transition-colors hover:border-primary/40 hover:bg-muted/30"
            >
              <h2 className="text-lg font-semibold tracking-tight">
                {entry.term}
              </h2>
              <p className="mt-1.5 line-clamp-3 text-sm text-muted-foreground">
                {entry.description}
              </p>
            </Link>
          ))}
        </section>
      </div>
    </div>
  );
}
