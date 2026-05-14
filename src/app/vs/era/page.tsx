import type { Metadata } from "next";
import { VsPage, type VsPageContent } from "../_components/VsPage";

export const metadata: Metadata = {
  title: "Finlynq vs Era — open-source vs closed AI personal finance",
  description:
    "Finlynq vs Era: open-source AGPL v3 with self-host + 91 MCP tools + per-user envelope encryption, compared against Era's closed-source hosted SaaS with 27 MCP tools and operator-held keys. Side-by-side feature table, when to choose each, and migration steps.",
  alternates: {
    canonical: "https://finlynq.com/vs/era",
  },
  openGraph: {
    title: "Finlynq vs Era — open-source vs closed AI personal finance",
    description:
      "Two MCP-first personal finance apps, compared. Finlynq: AGPL v3, self-hostable, 91 MCP tools, per-user envelope encryption. Era: closed SaaS, hosted-only, 27 MCP tools, operator-held keys.",
    url: "https://finlynq.com/vs/era",
    siteName: "Finlynq",
    type: "article",
  },
  twitter: {
    card: "summary_large_image",
    title: "Finlynq vs Era — open-source vs closed AI personal finance",
    description:
      "Open-source self-hostable PFM with 91 MCP tools and per-user envelope encryption, compared with Era.",
  },
};

const content: VsPageContent = {
  competitorName: "Era",
  slug: "era",
  tagline: (
    <>
      Era is a hosted, AI-first personal finance SaaS with a closed-source MCP
      server. Finlynq is the open-source, self-hostable alternative — same
      MCP-driven UX, your infrastructure, your encryption keys, no aggregator
      hostage.
    </>
  ),
  whenCompetitor: [
    <>
      You want bank sync to {`"`}just work{`"`} out of the box. Era ships with
      aggregator-grade automatic transactions across thousands of US
      institutions; Finlynq is currently file / email import only.
    </>,
    <>
      You want a native iOS / Android app today. Era&apos;s Agency is a real
      native mobile app; Finlynq has a mobile-friendly web UI but no native app
      yet.
    </>,
    <>
      You want regulated investment advisory or brokerage. Era&apos;s Thesis
      (private beta) is an SEC-registered investment adviser with brokerage via
      Alpaca. Finlynq is not — and explicitly never will be.
    </>,
    <>
      You don&apos;t want to think about Postgres, Docker, encryption keys, or
      password recovery. Era is hosted; that&apos;s the whole pitch.
    </>,
    <>
      You want shared household finances baked in. Era&apos;s multi-user shared
      views are first-class.
    </>,
  ],
  whenFinlynq: [
    <>
      <strong className="text-foreground">You want the source code.</strong>{" "}
      Finlynq is AGPL v3, fully on GitHub. Era is closed-source, so you
      can&apos;t audit the MCP tool implementations, the encryption story, or
      what gets sent to your AI assistant.
    </>,
    <>
      <strong className="text-foreground">You want to self-host.</strong>{" "}
      Finlynq runs on your hardware via Docker + PostgreSQL. Era cannot be
      self-hosted at any price.
    </>,
    <>
      <strong className="text-foreground">
        You want per-user encryption with keys derived from your password.
      </strong>{" "}
      Finlynq&apos;s envelope encryption (AES-256-GCM with scrypt-derived KEK)
      means even the operator cannot read your transaction notes, payees, tags,
      or display names. Era&apos;s {`"`}AES-256 at rest{`"`} is a blanket claim
      about Era&apos;s infra; the operator holds the keys.
    </>,
    <>
      <strong className="text-foreground">You want the bigger MCP surface.</strong>{" "}
      Finlynq exposes 91 HTTP tools and 87 stdio tools across budgets,
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
          Yes — <strong className="text-foreground">91 HTTP / 87 stdio</strong>{" "}
          tools
        </>
      ),
      competitor: (
        <>
          Yes — Era Context,{" "}
          <strong className="text-foreground">27 tools</strong> (per Anthropic
          directory listing, 2026-05-11)
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
      finlynq: "Yes — full surface mirrored from MCP",
      competitor: "Not publicly documented outside MCP",
    },
    {
      label: "Bank sync",
      finlynq:
        "File / email import + connector framework. No first-party Plaid integration today.",
      competitor:
        "Aggregator-based auto-sync (partner not publicly named); credential storage delegated to a SOC 2 Type II aggregator",
    },
    {
      label: "Encryption at rest",
      finlynq:
        "Per-user envelope encryption: AES-256-GCM with scrypt-derived KEK. The operator cannot decrypt user data.",
      competitor: `"AES-256 at rest" — Era holds the keys`,
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
      finlynq: "No (mobile web UI only)",
      competitor: "Yes — Agency",
    },
    {
      label: "Multi-user / household",
      finlynq: "No (single-user)",
      competitor: "Yes — shared views",
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
      staging-review pipeline at <code>/import/reconcile</code> — upload a CSV,
      review and edit each row, approve. Multi-currency, transfer-pair
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
          Because the comparison isn&apos;t price — it&apos;s where your data
          lives, who can read it, and what happens if the operator pivots.
          Finlynq&apos;s argument is structural, not a discount.
        </>
      ),
    },
    {
      q: "Doesn't Era's bank sync just make this a non-comparison for most users?",
      a: (
        <>
          For users who want one-click bank sync and don&apos;t care about
          source code or self-hosting, yes — Era is the better default.
          Finlynq&apos;s audience is users who specifically don&apos;t want a
          third-party aggregator holding their bank credentials, even one
          that&apos;s SOC 2 Type II.
        </>
      ),
    },
    {
      q: "Why does this read like a hit piece?",
      a: (
        <>
          It isn&apos;t. Era ships real things — first-party MCP, OAuth-scoped
          tools, native mobile, an investment-advisory product Finlynq legally
          cannot offer. The honest difference is: Era is hosted convenience for
          users who trust an operator with their financial life, and Finlynq is
          the substrate for users who don&apos;t want to.
        </>
      ),
    },
    {
      q: "Does Finlynq have a mobile app?",
      a: (
        <>
          Not yet. The web UI is mobile-friendly, but a native iOS / Android
          wrapper isn&apos;t shipped. If you need native mobile, Era is ahead.
        </>
      ),
    },
    {
      q: "Will Finlynq ever offer regulated investment advisory like Era's Thesis?",
      a: (
        <>
          No. Becoming an SEC-registered investment adviser is incompatible with
          the AGPL self-hostable design — the regulator wants a single
          accountable entity; the design wants none. Finlynq is the database;
          the user can hire whatever advisor they want against the data.
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
      label: "Anthropic Connectors Directory — Era listing",
      href: "https://context.era.app",
      note: "27 tools, visible from 2026-05-11",
    },
    {
      label: "Las Vegas Sun — Era launch coverage",
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
  lastUpdated: "2026-05-13",
};

export default function VsEraPage() {
  return <VsPage content={content} />;
}
