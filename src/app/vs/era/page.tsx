import type { Metadata } from "next";
import { VsPage, type VsPageContent } from "../_components/VsPage";

export const metadata: Metadata = {
  title: "Finlynq vs Era: open-source vs closed AI personal finance",
  description:
    "Finlynq vs Era: open-source AGPL v3 with self-host + 109 MCP tools + per-user envelope encryption, compared against Era's closed-source hosted SaaS with 27 MCP tools and operator-held keys. Side-by-side feature table, when to choose each, and migration steps.",
  alternates: {
    canonical: "/vs/era",
  },
  openGraph: {
    title: "Finlynq vs Era: open-source vs closed AI personal finance",
    description:
      "Two MCP-first personal finance apps, compared. Finlynq: AGPL v3, self-hostable, 109 MCP tools, per-user envelope encryption. Era: closed SaaS, hosted-only, 27 MCP tools, operator-held keys.",
    url: "/vs/era",
    siteName: "Finlynq",
    type: "article",
  },
  twitter: {
    card: "summary_large_image",
    title: "Finlynq vs Era: open-source vs closed AI personal finance",
    description:
      "Open-source self-hostable PFM with 109 MCP tools and per-user envelope encryption, compared with Era.",
  },
};

const content: VsPageContent = {
  competitorName: "Era",
  slug: "era",
  tagline: (
    <>
      Era is a hosted, AI-first personal finance SaaS with a closed-source MCP
      server. Finlynq is the open-source, self-hostable alternative. You get the
      same MCP-driven feel, but on your own infrastructure, with your own
      encryption keys, and no aggregator holding your data hostage.
    </>
  ),
  whenCompetitor: [
    <>
      You want the broadest bank coverage out of the box. Era ships
      aggregator-grade automatic transactions across thousands of US
      institutions. Finlynq now connects directly to your bank too, but
      Era&apos;s institution coverage is wider today.
    </>,
    <>
      You want the most polished native mobile experience. Era&apos;s Agency is
      a mature native app. Finlynq ships native iOS and Android apps too, on the
      App Store and Google Play.
    </>,
    <>
      You want regulated investment advisory or brokerage. Era&apos;s Thesis
      (private beta) is an SEC-registered investment adviser with brokerage
      through Alpaca. Finlynq isn&apos;t, and it never will be.
    </>,
    <>
      You&apos;d rather not think about Postgres, Docker, encryption keys, or
      password recovery. Era is hosted, and honestly that&apos;s the whole
      pitch.
    </>,
    <>
      You want shared household finances baked in. Era&apos;s multi-user shared
      views are first-class.
    </>,
  ],
  whenFinlynq: [
    <>
      <strong className="text-foreground">You want the source code.</strong>{" "}
      Finlynq is AGPL v3 and it&apos;s all on GitHub. Era is closed-source, so
      you can&apos;t audit the MCP tool implementations, the encryption story, or
      what actually gets sent to your AI assistant.
    </>,
    <>
      <strong className="text-foreground">You want to self-host.</strong>{" "}
      Finlynq runs on your own hardware with Docker and PostgreSQL. Era
      can&apos;t be self-hosted at any price.
    </>,
    <>
      <strong className="text-foreground">
        You want per-user encryption with keys derived from your password.
      </strong>{" "}
      Finlynq&apos;s envelope encryption (AES-256-GCM with a scrypt-derived KEK)
      means even the operator can&apos;t read your transaction notes, payees,
      tags, or display names. Era&apos;s {`"`}AES-256 at rest{`"`} is a blanket
      claim about Era&apos;s infra, and the operator still holds the keys.
    </>,
    <>
      <strong className="text-foreground">You want the bigger MCP surface.</strong>{" "}
      Finlynq exposes 109 HTTP tools and 93 stdio tools across budgets,
      transactions, portfolios, goals, loans, subscriptions, and rules.
      Era&apos;s public Context surface is 27 tools spanning accounts,
      connections, insights, billing, and a handful of other domains.
    </>,
    <>
      <strong className="text-foreground">
        You want plaintext-accounting workflows.
      </strong>{" "}
      Finlynq is built for users who already think in ledger files; Era is not.
    </>,
    <>
      <strong className="text-foreground">
        You want to own your data on the day Era pivots, gets acquired, or
        shuts down.
      </strong>{" "}
      With Finlynq, you do.
    </>,
  ],
  comparisonRows: [
    {
      label: "License",
      finlynq: "AGPL v3",
      competitor: "Closed source",
    },
    {
      label: "Hosting",
      finlynq: "Self-host (Docker + PostgreSQL) or managed cloud",
      competitor: "Hosted SaaS only",
    },
    {
      label: "First-party MCP",
      finlynq: (
        <>
          Yes, <strong className="text-foreground">109 HTTP / 93 stdio</strong>{" "}
          tools
        </>
      ),
      competitor: (
        <>
          Yes, Era Context,{" "}
          <strong className="text-foreground">27 tools</strong> (per the
          Anthropic directory listing, 2026-05-11)
        </>
      ),
    },
    {
      label: "MCP auth",
      finlynq: "OAuth 2.1 + DCR, Bearer API key, or stdio",
      competitor: "OAuth 2.1 with scoped permissions",
    },
    {
      label: "REST / HTTP API",
      finlynq: "Yes, the full surface is mirrored from MCP",
      competitor: "Not publicly documented outside MCP",
    },
    {
      label: "Bank sync",
      finlynq:
        "Direct bank connections (auto-sync), plus file / email import and a connector framework. Narrower institution coverage than Plaid-based sync.",
      competitor:
        "Aggregator-based auto-sync (partner not publicly named); credential storage delegated to a SOC 2 Type II aggregator",
    },
    {
      label: "Encryption at rest",
      finlynq:
        "Per-user envelope encryption: AES-256-GCM with scrypt-derived KEK. The operator cannot decrypt user data.",
      competitor: `"AES-256 at rest", but Era holds the keys`,
    },
    {
      label: "Multi-currency",
      finlynq: "Native, with per-currency cost-basis bucketing",
      competitor: "US-bank-feed centric (no public multi-currency claim)",
    },
    {
      label: "Investment / portfolio",
      finlynq:
        "Cost basis, dividends, FX-aware aggregation across accounts; not advisory",
      competitor:
        "Thesis (private beta): SEC-RIA portfolio analysis + brokerage via Alpaca",
    },
    {
      label: "Native mobile app",
      finlynq: "Yes, native iOS and Android apps (App Store, Google Play)",
      competitor: "Yes, Agency",
    },
    {
      label: "Multi-user / household",
      finlynq: "No (single-user)",
      competitor: "Yes, shared views",
    },
    {
      label: "Pricing",
      finlynq: "Donation-based; same features on self-host and managed cloud",
      competitor:
        "Freemium with paid tiers (specific amounts not disclosed publicly)",
    },
    {
      label: "Funding",
      finlynq: "Bootstrapped, donations",
      competitor: "$3M+ seed (Northzone et al.)",
    },
    {
      label: "Revenue model",
      finlynq: "Donations",
      competitor: "Subscriptions",
    },
    {
      label: "Anthropic Connectors Directory",
      finlynq: "Submitted 2026-05-09; awaiting review",
      competitor:
        "Press-announced 2026-05-06; visible in directory's Financial services category from 2026-05-11",
    },
  ],
  migrationSteps: [
    <>
      <strong className="text-foreground">
        Export the raw transactions you can.
      </strong>{" "}
      Use Era&apos;s UI export if available, or screenshot category and
      recurring rules. (Verify Era&apos;s current export options on era.app
      before relying on them.)
    </>,
    <>
      <strong className="text-foreground">Import into Finlynq.</strong> Use the
      staging-review pipeline at <code>/import/reconcile</code>: upload a CSV,
      review and edit each row, then approve. Multi-currency, transfer-pair
      detection, and dedup are all built into the staging flow.
    </>,
    <>
      <strong className="text-foreground">Hook up your AI client.</strong> Open
      Claude → Customize → Connectors → {`"`}+{`"`} → paste{" "}
      <code>https://finlynq.com/mcp</code>. OAuth handles the rest. For
      self-host, point Claude at your own deployment&apos;s <code>/mcp</code>{" "}
      URL.
    </>,
  ],
  faq: [
    {
      q: "Why are you comparing yourself to a paid product when you're free?",
      a: (
        <>
          Because the comparison isn&apos;t really about price. It&apos;s about
          where your data lives, who can read it, and what happens if the
          operator pivots. Finlynq&apos;s argument is structural, not a discount.
        </>
      ),
    },
    {
      q: "Doesn't Era's bank sync just make this a non-comparison for most users?",
      a: (
        <>
          Less so now. Finlynq added direct bank connections, so you can get
          one-click auto-sync too. Era&apos;s institution coverage is still
          broader, but Finlynq gives you the choice: connect a bank, or stay
          fully manual with CSV / OFX / email import, and either way your bank
          login stays with the aggregator, never Finlynq&apos;s servers.
        </>
      ),
    },
    {
      q: "Why does this read like a hit piece?",
      a: (
        <>
          It isn&apos;t. Era ships real things: first-party MCP, OAuth-scoped
          tools, native mobile, and an investment-advisory product Finlynq
          legally can&apos;t offer. The honest difference is that Era is hosted
          convenience for people who trust an operator with their financial
          life, and Finlynq is the substrate for people who&apos;d rather not.
        </>
      ),
    },
    {
      q: "Does Finlynq have a mobile app?",
      a: (
        <>
          Yes. Finlynq has native iOS and Android apps on the App Store and
          Google Play, covering Dashboard, Transactions, Import, Budgets, and
          Settings for everyday tracking on the go. They sign in to the same
          encrypted account as the web app.
        </>
      ),
    },
    {
      q: "Will Finlynq ever offer regulated investment advisory like Era's Thesis?",
      a: (
        <>
          No. Becoming an SEC-registered investment adviser just doesn&apos;t
          fit the AGPL self-hostable design. The regulator wants a single
          accountable entity, and the design wants none. Finlynq is the
          database, and you can hire whatever advisor you want to work against
          the data.
        </>
      ),
    },
  ],
  sources: [
    {
      label: "Era homepage",
      href: "https://era.app/",
      note: "fetched 2026-05-07",
    },
    {
      label: "Era Context explainer",
      href: "https://era.app/en-US/articles/what-is-era-context/",
      note: "fetched 2026-05-07",
    },
    {
      label: "Anthropic Connectors Directory (Era listing)",
      href: "https://context.era.app",
      note: "27 tools, visible from 2026-05-11",
    },
    {
      label: "Las Vegas Sun (Era launch coverage)",
      href: "https://lasvegassun.com/news/2026/may/06/era-becomes-the-first-personal-finance-connector-i/",
      note: "2026-05-06",
    },
    {
      label: "Finlynq on GitHub",
      href: "https://github.com/finlynq/finlynq",
      note: "AGPL v3 source",
    },
    {
      label: "Finlynq MCP guide",
      href: "/mcp-guide",
      note: "connect Claude, Cursor, Windsurf and more",
    },
  ],
  lastUpdated: "2026-07-01",
};

export default function VsEraPage() {
  return <VsPage content={content} />;
}
