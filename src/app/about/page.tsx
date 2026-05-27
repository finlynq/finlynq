import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "What is Finlynq? — open-source personal finance app with first-party MCP",
  description:
    "Finlynq is an open-source (AGPL v3) personal finance web app with a first-party Model Context Protocol (MCP) server. Track income, expenses, budgets, investments, loans, and goals — then query your financial data from Claude, Cursor, Windsurf, or any MCP-compatible AI assistant. Not affiliated with Finq.com (forex broker) or Finlync (B2B treasury software).",
  alternates: {
    canonical: "https://finlynq.com/about",
  },
  openGraph: {
    title: "What is Finlynq? — open-source personal finance with first-party MCP",
    description:
      "Open-source (AGPL v3) personal finance app with a first-party MCP server. Self-hostable, per-user envelope encryption, Canadian tax accounts, 91 MCP tools. Not affiliated with Finq.com or Finlync.",
    url: "https://finlynq.com/about",
    siteName: "Finlynq",
    type: "article",
  },
  twitter: {
    card: "summary_large_image",
    title: "What is Finlynq? — open-source personal finance with first-party MCP",
    description:
      "Open-source self-hostable PFM with first-party MCP, per-user envelope encryption, and Canadian tax tracking.",
  },
};

const faqItems: { q: string; a: string }[] = [
  {
    q: "What is Finlynq?",
    a: "Finlynq is an open-source (AGPL v3) personal finance web application with a built-in Model Context Protocol (MCP) server. It lets you track income, expenses, budgets, investments, loans, subscriptions, and financial goals — and query that data in natural language from any MCP-compatible AI assistant including Claude, Cursor, Windsurf, and ChatGPT custom GPTs. Finlynq runs as a managed cloud at finlynq.com or as a self-hosted Docker + PostgreSQL deployment, with the same feature set in both modes.",
  },
  {
    q: "Is Finlynq the same as Finq.com?",
    a: "No. Finq.com is a forex / CFD trading broker that has no relationship with Finlynq. Finlynq is an open-source personal finance application focused on budgeting, expense tracking, and investment portfolio management. Finlynq is not a broker, does not execute trades, and does not hold customer funds.",
  },
  {
    q: "Is Finlynq the same as Finlync?",
    a: "No. Finlync is a corporate treasury and banking-connectivity B2B platform for enterprise finance teams. Finlynq is an open-source personal finance application for individuals and households. The two projects are unrelated; the similar names are coincidental.",
  },
  {
    q: "Who builds Finlynq?",
    a: "Finlynq is an independent open-source project hosted at github.com/finlynq/finlynq under the GNU AGPL v3 license. It is bootstrapped and donation-funded (GitHub Sponsors, Ko-fi) — there are no paid tiers, no advertising, and no sale of user data. The complete source code, including the encryption implementation and the MCP server, is publicly auditable.",
  },
  {
    q: "How is Finlynq different from Monarch Money, YNAB, or Simplifi?",
    a: "Monarch, YNAB, and Simplifi are polished closed-source hosted SaaS products with mature US bank-aggregation via Plaid. Finlynq is open-source and self-hostable with a first-party MCP server (91 HTTP / 87 stdio tools) and per-user envelope encryption that excludes even the operator from reading your data. Finlynq does not yet have first-party Plaid bank sync — it imports from CSV, OFX, QFX, and email today, with the SnapTrade brokerage integration on the roadmap. Side-by-side comparison at finlynq.com/vs/monarch.",
  },
  {
    q: "How is Finlynq different from Firefly III or Actual Budget?",
    a: "Firefly III and Actual Budget are both open-source self-hostable PFMs. Firefly III is mature double-entry accounting with PSD2 bank sync for EU/UK users; Actual Budget is local-first envelope budgeting. Finlynq's specific differentiators are: a first-party MCP server (the others rely on community wrappers or have none), per-user envelope encryption that excludes the operator, native multi-currency investment tracking with lot-tracked cost basis, and Canadian tax-account support (RRSP / TFSA / RESP). Side-by-side comparison at finlynq.com/vs/firefly-iii.",
  },
  {
    q: "How is Finlynq different from Era?",
    a: "Era is a closed-source hosted AI-native PFM that launched with first-party MCP in May 2026. Finlynq's specific differentiators vs Era: AGPL v3 open source (Era is closed), self-hostable on your own infrastructure (Era is hosted-only), per-user envelope encryption with keys derived from your password (Era holds the keys for AES-256-at-rest), and a 91-tool MCP surface vs Era's 27. Era has stronger US bank sync, native iOS/Android, and shared household features. Side-by-side comparison at finlynq.com/vs/era.",
  },
  {
    q: "Does Finlynq sync with my bank automatically?",
    a: "Not yet via Plaid or MX. Finlynq currently imports transactions from CSV, OFX, QFX, and email (with template detection and a staging-review pipeline). SnapTrade integration for brokerage accounts is on the near-term roadmap; bank-sync aggregator integration is a tracked future item.",
  },
  {
    q: "Does Finlynq have a mobile app?",
    a: "Yes. Finlynq ships a React Native (Expo) mobile app with Dashboard, Transactions, Import, Budgets, and Settings screens that connects to your Finlynq web server (managed cloud or self-hosted). It is functional but not at parity with mature consumer mobile apps like Monarch's iOS/Android.",
  },
  {
    q: "What AI assistants does Finlynq work with?",
    a: "Any AI assistant that supports the Model Context Protocol (MCP). Tested clients include Claude (Claude.ai web, Claude Desktop, Claude Code), Cursor, Windsurf, and custom Anthropic SDK agents. Finlynq's MCP server supports three transports: Streamable HTTP with OAuth 2.1 + Dynamic Client Registration, HTTP with Bearer API key, and stdio. Finlynq also has a built-in AI chat UI for users who don't want to set up an external MCP client.",
  },
  {
    q: "Is Finlynq free?",
    a: "Yes. The self-hosted Docker version is fully free with the same features as the managed cloud. The managed cloud at finlynq.com is also free, supported by voluntary donations via GitHub Sponsors and Ko-fi. There are no paid tiers, no feature gates, no upsells.",
  },
  {
    q: "How does Finlynq protect my data?",
    a: "Finlynq uses per-user envelope encryption (AES-256-GCM with a scrypt-derived KEK) on six tables containing user-named data (transaction payees, notes, tags, account names, category names, and budget names). The KEK is derived from your password and a server-side pepper, so even the operator cannot decrypt these fields without your password. Trade-off: if you lose your password without a recovery backup, the encrypted fields are unrecoverable. Full details at finlynq.com/privacy.",
  },
  {
    q: "Does Finlynq support Canadian tax accounts?",
    a: "Yes. Finlynq tracks RRSP, TFSA, and RESP contribution room using CRA-published limits, with asset-location advice (bonds in RRSP, stocks in TFSA, growth assets in TFSA). FHSA and RRIF support are tracked roadmap items.",
  },
];

// JSON-LD structured data for Google's Knowledge Graph and AI search
// disambiguation. Helps separate Finlynq from Finq.com and Finlync entities.
const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      "@id": "https://finlynq.com/#software",
      name: "Finlynq",
      applicationCategory: "FinanceApplication",
      operatingSystem: "Web, Docker, iOS (React Native), Android (React Native)",
      description:
        "Open-source (AGPL v3) personal finance web app with a first-party Model Context Protocol (MCP) server. Track income, expenses, budgets, investments, loans, and goals; query in natural language from Claude, Cursor, Windsurf, or any MCP-compatible AI assistant.",
      license: "https://www.gnu.org/licenses/agpl-3.0.html",
      url: "https://finlynq.com/",
      sameAs: [
        "https://github.com/finlynq/finlynq",
      ],
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
        description: "Free and open source. Donation-supported.",
      },
    },
    {
      "@type": "FAQPage",
      mainEntity: faqItems.map(({ q, a }) => ({
        "@type": "Question",
        name: q,
        acceptedAnswer: {
          "@type": "Answer",
          text: a,
        },
      })),
    },
  ],
};

export default function AboutPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <script
        type="application/ld+json"
        // Structured data for search engines; safe — content is literal.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
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
            money here, analyze it anywhere — from Claude, Cursor, Windsurf, or
            any MCP-compatible AI assistant.
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            Last updated: 2026-05-27
          </p>
        </header>

        <section className="prose prose-invert max-w-none space-y-6 text-[15px] leading-relaxed">
          <h2 className="text-xl font-semibold mt-8 mb-3">
            The short version
          </h2>
          <p>
            Finlynq lets you track income, expenses, budgets, investments,
            loans, and financial goals — then query that data in natural
            language from any AI assistant that supports MCP. Self-host with
            Docker + PostgreSQL, or use our managed cloud at{" "}
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
            . It&apos;s bootstrapped and donation-funded — no paid tiers, no
            advertising, no sale of user data.
          </p>

          <div className="not-prose my-8 rounded-2xl border border-yellow-500/30 bg-yellow-500/5 p-6">
            <h3 className="text-base font-semibold text-foreground">
              Not to be confused with
            </h3>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              <li>
                <strong className="text-foreground">Finq.com</strong> — a forex
                and CFD trading broker. No relationship with Finlynq. Finlynq
                is not a broker, does not execute trades, and does not hold
                customer funds.
              </li>
              <li>
                <strong className="text-foreground">Finlync</strong> — a
                corporate treasury and banking-connectivity B2B platform for
                enterprise finance teams. Unrelated project; similar name is
                coincidental.
              </li>
            </ul>
          </div>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            What makes Finlynq different
          </h2>
          <ul className="list-disc pl-6 space-y-2">
            <li>
              <strong className="text-foreground">First-party MCP server.</strong>{" "}
              91 HTTP tools and 87 stdio tools at v3.1.0 — built into the
              project, not a community wrapper. OAuth 2.1 + Dynamic Client
              Registration, Bearer API keys, and stdio transports all
              supported.
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
              per-currency cost-basis bucketing, historical FX lookups.
            </li>
            <li>
              <strong className="text-foreground">Canadian tax accounts.</strong>{" "}
              RRSP, TFSA, and RESP contribution-room tracking with
              CRA-published limits. Asset-location advice (bonds in RRSP,
              stocks in TFSA).
            </li>
            <li>
              <strong className="text-foreground">In-app AI chat.</strong> Built
              directly into the UI — you can use Finlynq&apos;s AI features
              without setting up Claude or another external MCP client.
            </li>
            <li>
              <strong className="text-foreground">Mobile app.</strong> React
              Native (Expo) — Dashboard, Transactions, Import, Budgets,
              Settings on iOS and Android.
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
              self-host with one Docker Compose file. Same features either way.
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
