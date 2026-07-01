import Link from "next/link";
import type { Metadata } from "next";
import { AnalyticsConsent } from "@/components/analytics-consent";
import {
  JsonLd,
  softwareApplicationSchema,
  faqSchema,
  breadcrumbSchema,
} from "@/components/seo/json-ld";
import { MCP_TOOL_COUNTS, MCP_SERVER_VERSION } from "@/lib/mcp/tool-counts";

export const metadata: Metadata = {
  title: "What is Finlynq? Open-source personal finance app with first-party MCP",
  description:
    "Finlynq is an open-source (AGPL v3) personal finance web app with a first-party Model Context Protocol (MCP) server. Track income, expenses, budgets, investments, loans, and goals, then query your financial data from Claude, Cursor, Windsurf, or any MCP-compatible AI assistant. Not affiliated with Finq.com (forex broker) or Finlync (B2B treasury software).",
  alternates: {
    canonical: "/about",
  },
  openGraph: {
    title: "What is Finlynq? Open-source personal finance with first-party MCP",
    description:
      "Open-source (AGPL v3) personal finance app with a first-party MCP server. Self-hostable, per-user envelope encryption, Canadian tax accounts, 109 MCP tools. Not affiliated with Finq.com or Finlync.",
    url: "/about",
    siteName: "Finlynq",
    type: "article",
  },
  twitter: {
    card: "summary_large_image",
    title: "What is Finlynq? Open-source personal finance with first-party MCP",
    description:
      "Open-source self-hostable PFM with first-party MCP, per-user envelope encryption, and Canadian tax tracking.",
  },
};

const faqItems: { q: string; a: string }[] = [
  {
    q: "What is Finlynq?",
    a: "Finlynq is an open-source (AGPL v3) personal finance web application with a built-in Model Context Protocol (MCP) server. You track income, expenses, budgets, investments, loans, subscriptions, and financial goals, then ask about that data in plain language from any MCP-compatible AI assistant: Claude, Cursor, Windsurf, and ChatGPT custom GPTs all work. Run it on our managed cloud at finlynq.com, or self-host with Docker and PostgreSQL. You get the same features either way.",
  },
  {
    q: "Is Finlynq the same as Finq.com?",
    a: "No. Finq.com is a forex / CFD trading broker, and it has no relationship with Finlynq. Finlynq is an open-source personal finance app for budgeting, expense tracking, and investment portfolio management. It isn't a broker, doesn't execute trades, and never holds customer funds.",
  },
  {
    q: "Is Finlynq the same as Finlync?",
    a: "No. Finlync is a corporate treasury and banking-connectivity B2B platform built for enterprise finance teams. Finlynq is an open-source personal finance app for individuals and households. The two projects are unrelated. The similar names are just a coincidence.",
  },
  {
    q: "Who builds Finlynq?",
    a: "Finlynq is an independent open-source project hosted at github.com/finlynq/finlynq under the GNU AGPL v3 license. It's bootstrapped and donation-funded (GitHub Sponsors, Ko-fi). No paid tiers, no advertising, and no selling your data. The complete source, including the encryption code and the MCP server, is right there for anyone to audit.",
  },
  {
    q: "How is Finlynq different from Monarch Money, YNAB, or Simplifi?",
    a: "Monarch, YNAB, and Simplifi are polished closed-source hosted SaaS products with mature US bank-aggregation via Plaid. Finlynq is open-source and self-hostable, with a first-party MCP server (109 HTTP / 93 stdio tools) and per-user envelope encryption that keeps even the operator from reading your data. Finlynq now connects directly to your bank so transactions flow in automatically, and also imports from CSV, OFX, QFX, and email, with brokerage connections (SnapTrade) on the roadmap. Monarch's Plaid-based coverage spans more institutions today. There's a side-by-side comparison at finlynq.com/vs/monarch.",
  },
  {
    q: "How is Finlynq different from Firefly III or Actual Budget?",
    a: "Firefly III and Actual Budget are both open-source self-hostable PFMs. Firefly III is mature double-entry accounting with PSD2 bank sync for EU/UK users. Actual Budget is local-first envelope budgeting. So what sets Finlynq apart? A first-party MCP server (the others rely on community wrappers or have none), per-user envelope encryption that locks out the operator, native multi-currency investment tracking with lot-tracked cost basis, and Canadian tax-account support (RRSP / TFSA / RESP). There's a side-by-side comparison at finlynq.com/vs/firefly-iii.",
  },
  {
    q: "How is Finlynq different from Era?",
    a: "Era is a closed-source hosted AI-native PFM that launched with first-party MCP in May 2026. Here's where Finlynq parts ways: AGPL v3 open source (Era is closed), self-hostable on your own infrastructure (Era is hosted-only), per-user envelope encryption with keys derived from your password (Era holds the keys for its AES-256-at-rest), and a 109 HTTP / 93 stdio tool MCP surface (v3.3.0) against Era's 27. To be fair, Era has broader, more established bank coverage and shared household features. There's a side-by-side comparison at finlynq.com/vs/era.",
  },
  {
    q: "Does Finlynq sync with my bank automatically?",
    a: "Yes. Finlynq can connect directly to your bank so transactions flow in on their own, with template detection and a staging-review pipeline so you check things before they land. Your bank login never touches Finlynq's servers: the connection is authorized through a third-party aggregator that holds the credentials, not us. You can also still import from CSV, OFX, QFX, PDF, and email. Brokerage connections (SnapTrade) for investment accounts are on the near-term roadmap.",
  },
  {
    q: "Does Finlynq have a mobile app?",
    a: "Yep. Finlynq has native iOS and Android apps, free on the App Store and Google Play. They cover Dashboard, Transactions, Import, Budgets, and Settings, and they sign in to your Finlynq web server, whether that's the managed cloud or your own self-hosted box. They handle your everyday tracking on the go, and sync with the same encrypted account as the web app. The full story is at finlynq.com/blog/finlynq-mobile-app.",
  },
  {
    q: "What AI assistants does Finlynq work with?",
    a: "Any AI assistant that speaks the Model Context Protocol (MCP). We've tested Claude (Claude.ai web, Claude Desktop, Claude Code), Cursor, Windsurf, and custom Anthropic SDK agents. Finlynq's MCP server supports three transports: Streamable HTTP with OAuth 2.1 + Dynamic Client Registration, HTTP with a Bearer API key, and stdio. And if you'd rather not set up an external MCP client at all, there's a built-in AI chat UI right in the app.",
  },
  {
    q: "Is Finlynq free?",
    a: "Yes. The self-hosted Docker version is completely free, with the same features as the managed cloud. The managed cloud at finlynq.com is free too, kept running by voluntary donations through GitHub Sponsors and Ko-fi. No paid tiers, no feature gates, no upsells.",
  },
  {
    q: "How does Finlynq protect my data?",
    a: "Finlynq uses per-user envelope encryption (AES-256-GCM with a scrypt-derived KEK) on six tables that hold user-named data: transaction payees, notes, tags, account names, category names, and budget names. The KEK comes from your password plus a server-side pepper, so even the operator can't decrypt those fields without your password. There's a trade-off to be honest about: lose your password without a recovery backup and the encrypted fields are gone for good. Full details at finlynq.com/privacy.",
  },
  {
    q: "Does Finlynq support Canadian tax accounts?",
    a: "Yes. Finlynq tracks RRSP, TFSA, and RESP contribution room against CRA-published limits, and it offers asset-location advice (bonds in RRSP, stocks in TFSA, growth assets in TFSA). FHSA and RRIF support are on the roadmap.",
  },
];

export default function AboutPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <AnalyticsConsent />
      {/* JSON-LD for Google's Knowledge Graph + AI search disambiguation
          (separates Finlynq from Finq.com / Finlync). Routed through the
          nonce-aware <JsonLd> helper to satisfy the strict script-src CSP. */}
      <JsonLd data={softwareApplicationSchema()} />
      <JsonLd data={faqSchema(faqItems)} />
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "About", path: "/about" },
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
            About
          </div>
          <h1 className="mt-4 text-4xl font-bold tracking-tight">
            What is Finlynq?
          </h1>
          <p className="mt-4 text-base leading-relaxed text-muted-foreground">
            Finlynq is an open-source (AGPL v3) personal finance web application
            with a first-party Model Context Protocol (MCP) server. Track your
            money here, analyze it anywhere: Claude, Cursor, Windsurf, or any
            MCP-compatible AI assistant.
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            Last updated: 2026-07-01
          </p>
        </header>

        <section className="prose prose-invert max-w-none space-y-6 text-[15px] leading-relaxed">
          <h2 className="text-xl font-semibold mt-8 mb-3">
            The short version
          </h2>
          <p>
            Finlynq lets you track income, expenses, budgets, investments,
            loans, and financial goals, then ask about that data in plain
            language from any AI assistant that supports MCP. Self-host with
            Docker and PostgreSQL, or use our managed cloud at{" "}
            <code>finlynq.com</code>. Same features either way.
          </p>
          <p>
            It&apos;s licensed AGPL v3 with full source on GitHub at{" "}
            <a
              href="https://github.com/finlynq/finlynq"
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2 hover:text-primary"
            >
              github.com/finlynq/finlynq
            </a>
            . It&apos;s bootstrapped and donation-funded. No paid tiers, no
            advertising, no selling your data.
          </p>

          <div className="not-prose my-8 rounded-2xl border border-yellow-500/30 bg-yellow-500/5 p-6">
            <h3 className="text-base font-semibold text-foreground">
              Not to be confused with
            </h3>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              <li>
                <strong className="text-foreground">Finq.com</strong>: a forex
                and CFD trading broker. No relationship with Finlynq. Finlynq
                isn&apos;t a broker, doesn&apos;t execute trades, and never
                holds customer funds.
              </li>
              <li>
                <strong className="text-foreground">Finlync</strong>: a
                corporate treasury and banking-connectivity B2B platform for
                enterprise finance teams. Unrelated project, and the similar
                name is just a coincidence.
              </li>
            </ul>
          </div>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            What makes Finlynq different
          </h2>
          <ul className="list-disc pl-6 space-y-2">
            <li>
              <strong className="text-foreground">First-party MCP server.</strong>{" "}
              {MCP_TOOL_COUNTS.http} HTTP tools and {MCP_TOOL_COUNTS.stdio} stdio
              tools at v{MCP_SERVER_VERSION}, built into the project, not a
              community wrapper. OAuth 2.1 + Dynamic Client Registration, Bearer
              API keys, and stdio transports are all supported.
            </li>
            <li>
              <strong className="text-foreground">
                Per-user envelope encryption.
              </strong>{" "}
              AES-256-GCM with a scrypt-derived KEK. Even the operator
              can&apos;t read your transaction notes, payees, tags, or display
              names. Details at{" "}
              <Link href="/privacy" className="underline underline-offset-2 hover:text-primary">
                /privacy
              </Link>
              .
            </li>
            <li>
              <strong className="text-foreground">
                Native investment tracking.
              </strong>{" "}
              Lot-tracked cost basis, dividends, multi-currency support with
              per-currency cost-basis bucketing, and historical FX lookups.
            </li>
            <li>
              <strong className="text-foreground">Canadian tax accounts.</strong>{" "}
              RRSP, TFSA, and RESP contribution-room tracking against
              CRA-published limits, plus asset-location advice (bonds in RRSP,
              stocks in TFSA).
            </li>
            <li>
              <strong className="text-foreground">
                Direct bank connections.
              </strong>{" "}
              Link your bank and transactions flow in automatically, with a
              reconcile step before anything lands. Your bank login stays with
              the aggregator, never Finlynq&apos;s servers. CSV, OFX, QFX, PDF,
              and email import all still work too.
            </li>
            <li>
              <strong className="text-foreground">In-app AI chat.</strong> Built
              right into the UI, so you can use Finlynq&apos;s AI features
              without setting up Claude or another external MCP client.
            </li>
            <li>
              <strong className="text-foreground">Mobile app.</strong> React
              Native (Expo) covering Dashboard, Transactions, Import, Budgets,
              and Settings. Available now on the App Store and Google Play.{" "}
              <Link
                href="/blog/finlynq-mobile-app"
                className="underline underline-offset-2 hover:text-primary"
              >
                Read the announcement
              </Link>
              .
            </li>
            <li>
              <strong className="text-foreground">Self-hostable.</strong> Docker
              Compose with PostgreSQL. Same feature set as the managed cloud.
            </li>
          </ul>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            Compare with other personal finance apps
          </h2>
          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              <Link href="/vs/monarch" className="underline underline-offset-2 hover:text-primary">
                Finlynq vs Monarch Money
              </Link>
            </li>
            <li>
              <Link href="/vs/era" className="underline underline-offset-2 hover:text-primary">
                Finlynq vs Era
              </Link>
            </li>
            <li>
              <Link href="/vs/firefly-iii" className="underline underline-offset-2 hover:text-primary">
                Finlynq vs Firefly III
              </Link>
            </li>
            <li>
              <Link href="/vs/alderfi" className="underline underline-offset-2 hover:text-primary">
                Finlynq vs Alderfi
              </Link>
            </li>
          </ul>

          <h2 className="text-xl font-semibold mt-12 mb-3">FAQ</h2>
          <div className="not-prose space-y-3">
            {faqItems.map((item, i) => (
              <details
                key={i}
                className="group rounded-xl border border-border bg-card"
                {...(i < 3 ? { open: true } : {})}
              >
                <summary className="cursor-pointer list-none px-5 py-4 text-sm font-semibold text-foreground hover:bg-muted/30 transition-colors flex items-center justify-between gap-3">
                  <span>{item.q}</span>
                  <span className="text-muted-foreground text-xs group-open:rotate-180 transition-transform">
                    {"▾"}
                  </span>
                </summary>
                <div className="px-5 pb-4 text-sm text-muted-foreground leading-relaxed whitespace-pre-line">
                  {item.a}
                </div>
              </details>
            ))}
          </div>

          <div className="not-prose mt-12 rounded-2xl border border-primary/20 bg-primary/5 p-6">
            <h3 className="text-base font-semibold text-foreground">
              Try Finlynq
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Free, open source, AGPL v3. Run it on our managed cloud or
              self-host with a single Docker Compose file. Same features either
              way.
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
                prefetch={false}
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
