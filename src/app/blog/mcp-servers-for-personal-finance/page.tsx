import Link from "next/link";
import type { Metadata } from "next";
import { AnalyticsConsent } from "@/components/analytics-consent";
import {
  JsonLd,
  articleSchema,
  breadcrumbSchema,
  faqSchema,
} from "@/components/seo/json-ld";
import { MCP_TOOL_COUNTS } from "@/lib/mcp/tool-counts";

const SLUG = "mcp-servers-for-personal-finance";
const PUBLISHED = "2026-07-29";
const TITLE = "MCP servers for personal finance: which apps have one (2026)";

export const metadata: Metadata = {
  title: TITLE,
  description:
    "Monarch Money, YNAB, Actual Budget, Firefly III, Era, and Finlynq compared: which personal finance apps have an MCP server, which are first-party, and what each one asks you to hand over.",
  alternates: { canonical: `/blog/${SLUG}` },
  openGraph: {
    title: TITLE,
    description:
      "A field guide to MCP in personal finance: first-party servers, community wrappers, and the credential fine print behind each one.",
    type: "article",
    url: `/blog/${SLUG}`,
    siteName: "Finlynq",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description:
      "Which personal finance apps actually have an MCP server in 2026, and what each one asks you to hand over.",
  },
};

const FAQ = [
  {
    q: "Does Monarch Money have an MCP server?",
    a: "No official one, and no official developer API to build one on. Community MCP servers exist, but they use a reverse-engineered client library and need your real Monarch email, password, and MFA secret.",
  },
  {
    q: "Does YNAB have an MCP server?",
    a: "Not first-party. YNAB has an excellent official REST API, and community MCP servers wrap it using a personal access token, subject to a 200-requests-per-hour rate limit.",
  },
  {
    q: "Does Actual Budget have an MCP server?",
    a: "Not first-party. Several community MCP servers connect to a self-hosted Actual instance through its API. They work, but they are third-party projects and not integrated into the app.",
  },
  {
    q: "Does Firefly III have an MCP server?",
    a: "Not first-party. The feature request was closed without plans to ship. Community wrappers built on Firefly's REST API fill the gap.",
  },
  {
    q: "Which personal finance apps have a first-party MCP server?",
    a: `As of mid-2026, two: Era (closed source, hosted SaaS, 27 tools) and Finlynq (open source AGPL v3, self-hostable, ${MCP_TOOL_COUNTS.http} HTTP tools with OAuth 2.1).`,
  },
];

type LandscapeRow = {
  app: string;
  firstParty: string;
  api: string;
  connects: string;
};

const LANDSCAPE: LandscapeRow[] = [
  {
    app: "Finlynq",
    firstParty: `Yes: ${MCP_TOOL_COUNTS.http} HTTP / ${MCP_TOOL_COUNTS.stdio} stdio tools`,
    api: "Yes, full REST surface (Bearer key)",
    connects: "OAuth 2.1 + DCR, API key, or stdio",
  },
  {
    app: "Era",
    firstParty: "Yes: Era Context, 27 tools (closed source)",
    api: "Not publicly documented outside MCP",
    connects: "OAuth 2.1 with scoped permissions",
  },
  {
    app: "Monarch Money",
    firstParty: "No, and no official API",
    api: "None (community libraries reverse-engineer the private one)",
    connects: "Community MCP servers using your email + password + MFA secret",
  },
  {
    app: "YNAB",
    firstParty: "No",
    api: "Yes, official REST API (200 req/hr limit)",
    connects: "Community MCP servers using a personal access token",
  },
  {
    app: "Actual Budget",
    firstParty: "No (AI requests closed unmerged)",
    api: "Yes, via its sync-server API",
    connects: "Community MCP servers against your self-hosted instance",
  },
  {
    app: "Firefly III",
    firstParty: "No (request closed, no plans)",
    api: "Yes, official REST API",
    connects: "Community MCP wrappers using a personal access token",
  },
];

export default function McpServersForPersonalFinancePage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <AnalyticsConsent />
      <JsonLd
        data={articleSchema({
          title: TITLE,
          description:
            "Which personal finance apps have an MCP server in 2026, which are first-party, and what each one asks you to hand over.",
          path: `/blog/${SLUG}`,
          datePublished: PUBLISHED,
        })}
      />
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Blog", path: "/blog" },
          { name: TITLE, path: `/blog/${SLUG}` },
        ])}
      />
      <JsonLd data={faqSchema(FAQ)} />
      <div className="mx-auto max-w-3xl px-6 py-16">
        <header className="mb-12 border-b border-border pb-8">
          <Link
            href="/blog"
            className="text-xs font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            ← Finlynq blog
          </Link>
          <h1 className="mt-4 text-4xl font-bold tracking-tight">
            MCP servers for personal finance: which apps have one
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            The 2026 landscape, from someone who ships one · Published{" "}
            {PUBLISHED}
          </p>
        </header>

        <article className="prose prose-invert max-w-none space-y-6 text-[15px] leading-relaxed">
          <p className="text-base">
            If you have ever wanted to ask Claude {`"`}how much did I spend on
            groceries last month{`"`} and get an answer from your actual data,
            you were asking for an{" "}
            <Link href="/glossary/mcp-server">MCP server</Link>: a standard way
            for AI assistants to call tools against an app on your behalf.
            Personal finance is one of the most requested MCP use cases, and
            also the one where the details matter most, because the thing on
            the other end of the connection is your money. Here is where each
            major personal finance app actually stands in 2026.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            The landscape at a glance
          </h2>

          <div className="not-prose overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="py-2 pr-4 font-semibold">App</th>
                  <th className="py-2 pr-4 font-semibold">First-party MCP?</th>
                  <th className="py-2 pr-4 font-semibold">Official API?</th>
                  <th className="py-2 font-semibold">How AI connects</th>
                </tr>
              </thead>
              <tbody>
                {LANDSCAPE.map((row) => (
                  <tr key={row.app} className="border-b border-border/60 align-top">
                    <td className="py-2.5 pr-4 font-medium whitespace-nowrap">
                      {row.app}
                    </td>
                    <td className="py-2.5 pr-4">{row.firstParty}</td>
                    <td className="py-2.5 pr-4">{row.api}</td>
                    <td className="py-2.5">{row.connects}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p>
            The pattern: only two apps ship a first-party MCP server, and only
            one of those is open source. Everything else in the category is
            covered by community projects of varying quality, wrapping either
            an official API (YNAB, Actual, Firefly III) or a
            reverse-engineered private one (Monarch).
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            Why first-party vs community matters
          </h2>

          <p>
            A community MCP server is not a bad thing. Some are genuinely well
            built, and for apps whose vendors have said no to AI access, they
            are the only option. But the distinction matters in three concrete
            ways:
          </p>

          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              <strong>What you hand over.</strong> The best case is a scoped
              OAuth grant or a revocable API token. The worst case is your
              real email, password, and TOTP secret pasted into a config file,
              which is what the Monarch community servers require, because
              Monarch offers no official API at all.
            </li>
            <li>
              <strong>Who fixes it when it breaks.</strong> A wrapper on a
              reverse-engineered API can stop working any day, and the vendor
              owes it nothing. A first-party server ships and versions with
              the app.
            </li>
            <li>
              <strong>What the tools can see.</strong> With a closed-source
              server (first-party or not) you cannot audit what gets read and
              sent to the model. With an open-source first-party server, the
              tool implementations are in the same repo as the app.
            </li>
          </ul>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            A quick checklist before you connect any AI to your finances
          </h2>

          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              Prefer OAuth or a revocable token. Never paste your banking or
              app password into an MCP config if there is any alternative.
            </li>
            <li>
              Start read-only if the server supports it, and grant write
              scopes only once you trust the setup.
            </li>
            <li>
              Check whether destructive operations require confirmation.
              (Finlynq&apos;s delete and bulk tools use a two-step
              preview-then-confirm token, so a misfired prompt cannot wipe
              anything in one shot.)
            </li>
            <li>
              Ask where the data lives and who holds the keys. An MCP server
              is only as private as the database behind it.
            </li>
          </ul>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            Where Finlynq fits
          </h2>

          <p>
            Finlynq is the open-source entry in that table: AGPL v3,
            self-hostable, with a first-party MCP server exposing{" "}
            {MCP_TOOL_COUNTS.http} HTTP tools (and {MCP_TOOL_COUNTS.stdio} over
            stdio) across accounts, transactions, budgets, portfolios, goals,
            loans, subscriptions, and reconciliation. Auth is OAuth 2.1 with
            dynamic client registration, per-user envelope encryption means
            the operator cannot read your data, and the whole surface is
            auditable on GitHub. The{" "}
            <Link href="/mcp-guide">MCP guide</Link> walks through connecting
            Claude, ChatGPT, Cursor, or any other MCP client in a couple of
            minutes, and the <Link href="/try-demo?next=/dashboard">live demo</Link>{" "}
            lets you try the whole thing without signing up.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">FAQ</h2>

          <div className="not-prose space-y-3">
            {FAQ.map((item) => (
              <details
                key={item.q}
                className="group rounded-xl border border-border bg-card"
              >
                <summary className="cursor-pointer px-4 py-3 font-medium">
                  {item.q}
                </summary>
                <p className="px-4 pb-4 text-sm text-muted-foreground">
                  {item.a}
                </p>
              </details>
            ))}
          </div>

          <p className="text-sm text-muted-foreground mt-10">
            Fact-checked {PUBLISHED}. Competitor details come from each
            project&apos;s public repos and docs; corrections welcome via{" "}
            <a
              href="https://github.com/finlynq/finlynq/discussions"
              target="_blank"
              rel="noreferrer"
            >
              GitHub Discussions
            </a>
            . For deeper one-on-one comparisons, see{" "}
            <Link href="/vs">Finlynq vs everyone</Link>.
          </p>
        </article>
      </div>
    </div>
  );
}
