import Link from "next/link";
import type { Metadata } from "next";
import { AnalyticsConsent } from "@/components/analytics-consent";
import { JsonLd, breadcrumbSchema } from "@/components/seo/json-ld";

const PATH = "/roadmap";

export const metadata: Metadata = {
  title: "Roadmap | Finlynq",
  description:
    "What's live, what we're building, and what's next for Finlynq, the open-source personal finance app with a first-party MCP server. Directional, community-shaped, AGPL v3.",
  alternates: { canonical: PATH },
  openGraph: {
    title: "Finlynq roadmap",
    description:
      "What's live, what we're building now, and what's next. Directional, community-shaped, open source.",
    url: PATH,
    type: "website",
    siteName: "Finlynq",
  },
  twitter: {
    card: "summary_large_image",
    title: "Finlynq roadmap",
    description:
      "What's live, what we're building now, and what's next for the open-source, MCP-first personal finance app.",
  },
};

const INTRO =
  "Here's what's already live, what we're building now, and what we're weighing next. It's directional, not a contract: priorities shift, and since Finlynq is open source (AGPL v3), the community can build any of it too. Want something moved up the list? Send feedback in the app or open a discussion on GitHub.";

const CTA =
  "Got an opinion on what should come next? Send feedback from inside the app, or open a discussion on GitHub. Finlynq is AGPL v3, so issues and pull requests are welcome too.";

type Item = {
  title: string;
  desc: string;
  href?: string;
  hrefLabel?: string;
};

type Section = {
  key: string;
  label: string;
  blurb: string;
  /** Tailwind classes for the status badge pill. */
  badge: string;
  items: Item[];
};

const SECTIONS: Section[] = [
  {
    key: "live",
    label: "Live now",
    blurb: "Already shipped, and in the app today.",
    badge: "bg-emerald-500/15 text-emerald-500",
    items: [
      {
        title: "Talk to your money with any AI assistant",
        // keep in sync with src/lib/mcp/tool-counts.ts
        desc: "A built-in MCP server (109 HTTP / 93 stdio tools) for Claude, Cursor, and the rest.",
        href: "/mcp-guide",
        hrefLabel: "See the MCP guide",
      },
      {
        title: "Private by design",
        desc: "Per-user encryption means even we can't read your account names, payees, or notes.",
        href: "/blog/how-finlynq-encrypts-your-money",
        hrefLabel: "How encryption works",
      },
      {
        title: "Investments that actually track",
        desc: "Live prices, lot-level cost basis, dividends, XIRR, benchmarks, and FX-aware realized gains.",
      },
      {
        title: "Multi-currency net worth",
        desc: "Hold accounts in any currency and still see one consolidated picture.",
      },
      {
        title: "Import from anywhere",
        desc: "CSV, Excel, PDF, OFX/QFX, and forward-by-email statements. There's a reconcile step before anything lands.",
      },
      {
        title: "Budgets your way",
        desc: "Envelope or zero-based, with rollover.",
      },
      {
        title: "Plan ahead",
        desc: "Set savings goals and watch your progress toward them.",
      },
      {
        title: "See the whole picture",
        desc: "Sankey cash flow, income statement, net-worth trend, spending anomalies, and a financial health score.",
      },
      {
        title: "Run it your way",
        desc: "Free managed cloud, or self-host with Docker. Same features either way.",
        href: "/self-hosted",
        hrefLabel: "Self-hosting guide",
      },
      {
        title: "Native mobile apps",
        desc: "Finlynq on your phone, now available on the App Store and Google Play. Point it at the managed cloud or your own self-hosted instance.",
        href: "/blog/finlynq-mobile-app",
        hrefLabel: "Read the announcement",
      },
    ],
  },
  {
    key: "building",
    label: "Building now",
    blurb: "In active development.",
    badge: "bg-amber-500/15 text-amber-500",
    items: [
      {
        title: "In-app AI chat",
        desc: "Ask questions about your finances in plain English, no external MCP client required. In active development behind a feature flag.",
      },
      {
        title: "Automatic account connections",
        desc: "Link banks and brokerages so transactions flow in on their own. We're starting with US banks (SimpleFIN) and North American brokerages, including Wealthsimple, Questrade, and IBKR (SnapTrade). You keep the connection and the credentials, not us.",
      },
    ],
  },
  {
    key: "next",
    label: "Up next",
    blurb: "Planned direction, no dates yet.",
    badge: "bg-sky-500/15 text-sky-500",
    items: [
      {
        title: "Snap a receipt, skip the typing",
        desc: "OCR for receipts and statements, plus one-click migration from YNAB, Mint, and Monarch.",
      },
      {
        title: "Categorization that learns",
        desc: "Smarter auto-categorization, cleaner merchant names, and faster bulk edits and splits.",
      },
      {
        title: "Budgeting and savings, deeper",
        desc: "Sinking funds, round-ups and auto-save rules, and net-worth milestones.",
      },
      {
        title: "Debt payoff and FIRE planning",
        desc: "Avalanche and snowball payoff strategies, plus FIRE projections with Monte Carlo simulations.",
      },
      {
        title: "More for investors",
        desc: "A dividend calendar and yields, tax-loss harvesting, equity comp (RSU/ESPP/options), and real-estate tracking.",
      },
      {
        title: "Smarter tax tools",
        desc: "Sales tax (GST/HST/VAT), quarterly estimates, asset-location advice, and more regions beyond Canada.",
      },
      {
        title: "Dashboards and reports you control",
        desc: "Build your own, schedule them to your inbox, and share a read-only view.",
      },
    ],
  },
  {
    key: "exploring",
    label: "Exploring",
    blurb: "Ideas we're weighing. Vote for what matters to you.",
    badge: "bg-violet-500/15 text-violet-400",
    items: [
      {
        title: "Full retirement planning",
        desc: "Withdrawal sequencing, CPP/OAS/Social Security, insurance, estate, and education savings.",
      },
      {
        title: "Notifications that reach you",
        desc: "Mobile push, a weekly recap email, bill and renewal reminders, and price alerts.",
      },
      {
        title: "Built for freelancers and small business",
        desc: "Invoicing, business books, mileage, and contractor income.",
      },
      {
        title: "Share with the people who matter",
        desc: "Partner and household access, read-only access for your advisor, and a community hub.",
      },
    ],
  },
];

function ItemLink({ href, label }: { href: string; label: string }) {
  const cls =
    "mt-2 inline-block text-xs font-medium underline underline-offset-2 hover:text-primary";
  if (href.startsWith("http")) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={cls}>
        {label} →
      </a>
    );
  }
  return (
    <Link href={href} className={cls}>
      {label} →
    </Link>
  );
}

export default function RoadmapPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <AnalyticsConsent />
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Roadmap", path: PATH },
        ])}
      />
      <div className="mx-auto max-w-4xl px-6 py-16">
        <header className="mb-12 border-b border-border pb-8">
          <Link
            href="/"
            className="text-xs font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            ← Finlynq
          </Link>
          <p className="mt-4 text-xs font-mono uppercase tracking-wider text-primary">
            Roadmap
          </p>
          <h1 className="mt-2 text-4xl font-bold tracking-tight">
            Where Finlynq is headed
          </h1>
          <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-muted-foreground">
            {INTRO}
          </p>
        </header>

        <div className="space-y-14">
          {SECTIONS.map((section) => (
            <section key={section.key}>
              <div className="mb-1 flex items-center gap-3">
                <span
                  className={`rounded-full px-2.5 py-1 text-xs font-semibold ${section.badge}`}
                >
                  {section.label}
                </span>
              </div>
              <p className="mb-5 text-sm text-muted-foreground">
                {section.blurb}
              </p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {section.items.map((item) => (
                  <div
                    key={item.title}
                    className="rounded-lg border border-border bg-card/40 p-4"
                  >
                    <h3 className="text-[15px] font-semibold tracking-tight">
                      {item.title}
                    </h3>
                    <p className="mt-1.5 text-sm leading-relaxed text-foreground/80">
                      {item.desc}
                    </p>
                    {item.href && item.hrefLabel && (
                      <ItemLink href={item.href} label={item.hrefLabel} />
                    )}
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>

        <footer className="mt-16 border-t border-border pt-8">
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {CTA}
          </p>
          <div className="mt-4 flex flex-wrap gap-4 text-sm">
            <a
              href="https://github.com/finlynq/finlynq/discussions"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-primary"
            >
              GitHub Discussions →
            </a>
            <Link
              href="/cloud?tab=register"
              className="underline underline-offset-2 hover:text-primary"
            >
              Try Finlynq free →
            </Link>
            <Link
              href="/try-demo?next=/dashboard"
              className="underline underline-offset-2 hover:text-primary"
            >
              Try the live demo (no signup) →
            </Link>
          </div>
        </footer>
      </div>
    </div>
  );
}
