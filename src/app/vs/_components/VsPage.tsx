import Link from "next/link";
import type { ReactNode } from "react";
import { AnalyticsConsent } from "@/components/analytics-consent";

/**
 * Shared layout for `/vs/<competitor>` comparison pages.
 *
 * Data-driven so each `/vs/<slug>/page.tsx` only owns its content. Pages render
 * inside a dark prose layout that mirrors `/privacy` and `/terms` — content
 * rather than the premium `fl-landing` motion system, which would distract from
 * a research-mode read.
 *
 * Pattern for adding a new `/vs/<slug>`:
 *   1. Create `pf-app/src/app/vs/<slug>/page.tsx` with a default export.
 *   2. Set the `metadata` export (title + description) for SEO / LLM citation.
 *   3. Build a `VsPageContent` object and pass it to `<VsPage>`.
 *   4. Add the slug to `pf-app/src/app/sitemap.ts` and the landing footer.
 */

export type ComparisonRow = {
  label: string;
  finlynq: ReactNode;
  competitor: ReactNode;
};

export type FaqItem = {
  q: string;
  a: ReactNode;
};

export type SourceLink = {
  label: string;
  href: string;
  note?: string;
};

export type VsPageContent = {
  /** Short competitor name, used in headings and table column header. */
  competitorName: string;
  /** Slug, e.g. "era". Used internally; not rendered. */
  slug: string;
  /** One-paragraph framing intro shown under the H1. */
  tagline: ReactNode;
  /** Bullets shown under "When to choose <competitor>". */
  whenCompetitor: ReactNode[];
  /** Bullets shown under "When to choose Finlynq". */
  whenFinlynq: ReactNode[];
  /** Side-by-side comparison rows. */
  comparisonRows: ComparisonRow[];
  /** Optional "Migrating from <competitor>" steps. */
  migrationSteps?: ReactNode[];
  /** FAQ items. */
  faq: FaqItem[];
  /** Citation links shown at the bottom. */
  sources: SourceLink[];
  /** ISO date the comparison was last fact-checked. */
  lastUpdated: string;
};

export function VsPage({ content }: { content: VsPageContent }) {
  const {
    competitorName,
    tagline,
    whenCompetitor,
    whenFinlynq,
    comparisonRows,
    migrationSteps,
    faq,
    sources,
    lastUpdated,
  } = content;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AnalyticsConsent />
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
            Comparison
          </div>
          <h1 className="mt-4 text-4xl font-bold tracking-tight">
            Finlynq vs {competitorName}
          </h1>
          <p className="mt-4 text-base leading-relaxed text-muted-foreground">
            {tagline}
          </p>
          <p className="mt-4 text-xs text-muted-foreground">
            Last updated: {lastUpdated}
          </p>
        </header>

        <section className="prose prose-invert max-w-none space-y-8 text-[15px] leading-relaxed">
          {/* When to choose competitor */}
          <h2 className="text-xl font-semibold mt-12 mb-3">
            When to choose {competitorName}
          </h2>
          <p>
            {competitorName} is the right call if any of these matter more than
            ownership:
          </p>
          <ul className="list-disc pl-6 space-y-2">
            {whenCompetitor.map((bullet, i) => (
              <li key={i}>{bullet}</li>
            ))}
          </ul>

          {/* When to choose Finlynq */}
          <h2 className="text-xl font-semibold mt-12 mb-3">
            When to choose Finlynq
          </h2>
          <p>Finlynq is the right call if any of these matter:</p>
          <ul className="list-disc pl-6 space-y-2">
            {whenFinlynq.map((bullet, i) => (
              <li key={i}>{bullet}</li>
            ))}
          </ul>

          {/* Side-by-side comparison */}
          <h2 className="text-xl font-semibold mt-12 mb-3">Side-by-side</h2>
          <div className="not-prose overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="px-4 py-3 text-xs font-mono uppercase tracking-wider text-muted-foreground">
                    &nbsp;
                  </th>
                  <th className="px-4 py-3 text-xs font-mono uppercase tracking-wider text-primary">
                    Finlynq
                  </th>
                  <th className="px-4 py-3 text-xs font-mono uppercase tracking-wider text-muted-foreground">
                    {competitorName}
                  </th>
                </tr>
              </thead>
              <tbody>
                {comparisonRows.map((row, i) => (
                  <tr
                    key={i}
                    className={
                      i % 2 === 0
                        ? "border-b border-border/50"
                        : "border-b border-border/50 bg-muted/10"
                    }
                  >
                    <th className="px-4 py-3 align-top font-semibold text-foreground">
                      {row.label}
                    </th>
                    <td className="px-4 py-3 align-top text-muted-foreground">
                      {row.finlynq}
                    </td>
                    <td className="px-4 py-3 align-top text-muted-foreground">
                      {row.competitor}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Migration steps (optional) */}
          {migrationSteps && migrationSteps.length > 0 && (
            <>
              <h2 className="text-xl font-semibold mt-12 mb-3">
                Migrating from {competitorName}
              </h2>
              <ol className="list-decimal pl-6 space-y-2">
                {migrationSteps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
            </>
          )}

          {/* FAQ */}
          <h2 className="text-xl font-semibold mt-12 mb-3">FAQ</h2>
          <div className="not-prose space-y-3">
            {faq.map((item, i) => (
              <details
                key={i}
                className="group rounded-xl border border-border bg-card"
              >
                <summary className="cursor-pointer list-none px-5 py-4 text-sm font-semibold text-foreground hover:bg-muted/30 transition-colors flex items-center justify-between gap-3">
                  <span>{item.q}</span>
                  <span className="text-muted-foreground text-xs group-open:rotate-180 transition-transform">
                    {"▾"}
                  </span>
                </summary>
                <div className="px-5 pb-4 text-sm text-muted-foreground leading-relaxed">
                  {item.a}
                </div>
              </details>
            ))}
          </div>

          {/* Sources */}
          <h2 className="text-xl font-semibold mt-12 mb-3">Sources</h2>
          <ul className="list-disc pl-6 space-y-1.5 text-sm text-muted-foreground">
            {sources.map((source, i) => (
              <li key={i}>
                <a
                  href={source.href}
                  className="underline underline-offset-2 hover:text-primary"
                  target={source.href.startsWith("http") ? "_blank" : undefined}
                  rel={
                    source.href.startsWith("http")
                      ? "noreferrer noopener"
                      : undefined
                  }
                >
                  {source.label}
                </a>
                {source.note ? (
                  <span className="ml-1 text-muted-foreground/80">
                    — {source.note}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>

          {/* Soft CTA — research-mode page, one link only per the brief */}
          <div className="not-prose mt-12 rounded-2xl border border-primary/20 bg-primary/5 p-6">
            <h3 className="text-base font-semibold text-foreground">
              Try Finlynq
            </h3>
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
                href="/self-hosted"
                className="inline-flex items-center gap-2 rounded-xl border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted/40 transition-colors"
              >
                Self-host with Docker
              </Link>
              <a
                href="https://github.com/finlynq/finlynq"
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-2 rounded-xl border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted/40 transition-colors"
              >
                Source on GitHub
              </a>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
