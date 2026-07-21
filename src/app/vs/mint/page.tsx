import type { Metadata } from "next";
import { VsPage, type VsPageContent } from "../_components/VsPage";
import { MCP_TOOL_COUNTS, MCP_SERVER_VERSION } from "@/lib/mcp/tool-counts";

export const metadata: Metadata = {
  title: "Finlynq vs Mint: an open-source Mint alternative after the shutdown",
  description:
    "Mint shut down in 2024. Finlynq is the open-source (AGPL v3), self-hostable Mint alternative: no ads, per-user encryption, and a first-party MCP server.",
  alternates: {
    canonical: "/vs/mint",
  },
  openGraph: {
    title: "Finlynq vs Mint: an open-source Mint alternative after the shutdown",
    description: `Intuit shut Mint down in March 2024 and moved users to Credit Karma, which isn't a budgeting tool. Finlynq is the open-source, self-hostable, ad-free alternative: AGPL v3, per-user envelope encryption, ${MCP_TOOL_COUNTS.http} MCP tools, and a real import pipeline for your old Mint CSV.`,
    url: "/vs/mint",
    siteName: "Finlynq",
    type: "article",
  },
  twitter: {
    card: "summary_large_image",
    title: "Finlynq vs Mint: open-source Mint alternative",
    description: `A free, open-source, self-hostable Mint alternative with no ads, per-user encryption, and ${MCP_TOOL_COUNTS.http} MCP tools. Import your old Mint CSV and own your data.`,
  },
};

const content: VsPageContent = {
  competitorName: "Mint",
  slug: "mint",
  tagline: (
    <>
      Intuit shut Mint down on March 23, 2024 and pushed users to Credit Karma,
      which shows balances and a credit score but is not a budgeting,
      net-worth, or portfolio tool. So the real question is not
      &quot;Finlynq vs Mint&quot; but &quot;what do I replace Mint with?&quot;
      Finlynq is the open-source, self-hostable, ad-free answer: your data on
      your own hardware, encryption keys derived from your password, and a
      first-party MCP server so your AI assistant can actually work with your
      money.
    </>
  ),
  whenCompetitorHeading: <>What happened to Mint (and what you&apos;ll miss)</>,
  whenCompetitorIntro: (
    <>
      Mint is gone, so you can&apos;t actually choose it anymore. But it did a
      few things well, and any replacement should be judged against them.
      Here&apos;s what Mint got right:
    </>
  ),
  whenCompetitor: [
    <>
      <strong className="text-foreground">
        It was free and completely hands-off.
      </strong>{" "}
      Mint was free because it was ad- and affiliate-supported: Intuit made
      money recommending credit cards and loans and using your financial data
      to target them. If being the product in exchange for zero cost and zero
      setup worked for you, that was the whole appeal.
    </>,
    <>
      <strong className="text-foreground">
        Automatic bank sync across almost everything.
      </strong>{" "}
      Intuit&apos;s aggregation covered a huge range of US banks and cards with
      near-zero configuration. Finlynq supports direct bank connections
      (auto-sync) plus file / CSV / OFX import, but with narrower institution
      coverage than Intuit had.
    </>,
    <>
      <strong className="text-foreground">
        Bill reminders and a familiar auto-categorization flow.
      </strong>{" "}
      Mint&apos;s categorization and due-date nudges were simple and familiar to
      millions of people. Finlynq has auto-categorize rules and recurring /
      subscription detection, but the muscle memory is different.
    </>,
    <>
      <strong className="text-foreground">
        You never had to think about hosting.
      </strong>{" "}
      Mint was a hosted service with a team behind it. Finlynq has a hosted
      option at <code>finlynq.com/cloud</code>, but its center of gravity is
      self-hosting, which means Docker, PostgreSQL, and owning your own
      password recovery.
    </>,
  ],
  whenFinlynq: [
    <>
      <strong className="text-foreground">
        You want a Mint replacement that can&apos;t be shut down on you.
      </strong>{" "}
      Mint proved that a free, closed, ad-funded PFM exists at the mercy of its
      owner&apos;s roadmap. Finlynq is AGPL v3 on GitHub and donation-funded, so
      you can always run it yourself and there&apos;s no acquirer to pull the
      plug.
    </>,
    <>
      <strong className="text-foreground">
        You&apos;re done being the product.
      </strong>{" "}
      Mint&apos;s business model was selling you financial products and using
      your data to do it. Finlynq has no ads, no affiliate cross-sell, and
      per-user envelope encryption (AES-256-GCM with a scrypt-derived key) so
      that if you self-host, even the operator can&apos;t read your payees,
      notes, tags, or account names.
    </>,
    <>
      <strong className="text-foreground">
        You want your data on your own hardware.
      </strong>{" "}
      Finlynq runs via Docker + PostgreSQL with the same feature set as the
      managed cloud. Mint could never be self-hosted, and when it closed, the
      product simply disappeared.
    </>,
    <>
      <strong className="text-foreground">
        You still have your old Mint export and want to keep the history.
      </strong>{" "}
      If you exported a Mint CSV before the shutdown (or have one from Credit
      Karma), Finlynq&apos;s staging-review import pipeline handles it, with
      dedup, transfer-pair detection, and multi-currency support.
    </>,
    <>
      <strong className="text-foreground">
        You want investments and multi-currency done properly.
      </strong>{" "}
      Mint&apos;s investment tracking was thin and US-centric. Finlynq ships
      lot-tracked cost basis, dividends, FX-aware aggregation, and RRSP / TFSA /
      RESP contribution-room tracking for Canadian accounts.
    </>,
    <>
      <strong className="text-foreground">
        You want a first-party MCP server with {MCP_TOOL_COUNTS.http} HTTP /{" "}
        {MCP_TOOL_COUNTS.stdio} stdio tools.
      </strong>{" "}
      Mint had no AI story at all. Finlynq ships MCP as a core feature (OAuth
      2.1 + DCR, Bearer API keys, stdio), so Claude, Cursor, or any MCP client
      can read and manage your finances, plus an in-app AI chat with no client
      setup required.
    </>,
  ],
  comparisonRows: [
    {
      label: "Status",
      finlynq: "Actively developed",
      competitor: "Discontinued (shut down March 23, 2024)",
    },
    {
      label: "Successor",
      finlynq: "n/a",
      competitor: "Credit Karma (balances + credit score, not a PFM)",
    },
    {
      label: "License",
      finlynq: "AGPL v3 (open source)",
      competitor: "Closed source (Intuit)",
    },
    {
      label: "Cost",
      finlynq: "Donation-based; no ads, no data sold",
      competitor: "Free, funded by ads + affiliate cross-sell",
    },
    {
      label: "Business model",
      finlynq: "Donations",
      competitor: "Advertising + selling financial products",
    },
    {
      label: "Hosting",
      finlynq: "Self-host (Docker + PostgreSQL) or managed cloud",
      competitor: "Hosted SaaS (now gone)",
    },
    {
      label: "Data ownership",
      finlynq:
        "Your database; per-user envelope encryption excludes the operator (self-host)",
      competitor: "Intuit-owned; used for ad targeting and cross-sell",
    },
    {
      label: "Encryption at rest",
      finlynq:
        "Per-user envelope encryption: AES-256-GCM with scrypt-derived KEK",
      competitor: "Infrastructure-level only; Intuit held the keys",
    },
    {
      label: "First-party MCP",
      finlynq: (
        <>
          Yes,{" "}
          <strong className="text-foreground">
            {MCP_TOOL_COUNTS.http} HTTP / {MCP_TOOL_COUNTS.stdio} stdio
          </strong>{" "}
          tools, v{MCP_SERVER_VERSION}
        </>
      ),
      competitor: "None",
    },
    {
      label: "In-app AI chat",
      finlynq: "Yes, built into the UI",
      competitor: "None",
    },
    {
      label: "Bank sync",
      finlynq:
        "Direct bank connections (auto-sync) plus file / CSV / OFX import",
      competitor: "Intuit aggregation (broad US coverage, now gone)",
    },
    {
      label: "Import your old data",
      finlynq: "Yes, staging-review CSV / OFX pipeline with dedup",
      competitor: "CSV export was available before shutdown",
    },
    {
      label: "Investments / portfolio",
      finlynq:
        "Lot-tracked cost basis, dividends, FX-aware aggregation, contribution-room tracking",
      competitor: "Basic, US-centric",
    },
    {
      label: "Multi-currency",
      finlynq: "Native, with per-currency cost basis and historical FX",
      competitor: "Weak; US-only in practice",
    },
    {
      label: "Native mobile app",
      finlynq: "Yes, native iOS and Android (App Store, Google Play)",
      competitor: "iOS + Android (discontinued)",
    },
    {
      label: "Ads",
      finlynq: "None",
      competitor: "Yes, core to the product",
    },
  ],
  migrationSteps: [
    <>
      <strong className="text-foreground">Find your Mint export.</strong> If
      you saved a transactions CSV before Mint closed, or have one from Credit
      Karma, you already have what you need. If not, unfortunately Mint&apos;s
      export is no longer retrievable, and you can start fresh from your bank
      statements instead.
    </>,
    <>
      <strong className="text-foreground">Import into Finlynq.</strong> Upload
      the CSV at <code>/import</code>. The staging-review pipeline handles
      multi-currency, transfer-pair detection, and duplicate flagging, and you
      approve once you&apos;ve reviewed the mapping.
    </>,
    <>
      <strong className="text-foreground">Re-create your categories.</strong>{" "}
      Mint&apos;s category names don&apos;t carry over cleanly. Map columns
      during import, then tidy up with Finlynq&apos;s categories and
      auto-categorize rules so future imports sort themselves.
    </>,
    <>
      <strong className="text-foreground">Set up your budgets.</strong> Use the
      budget UI (or the <code>set_budget</code> MCP tool) to re-author your
      most-used categories.
    </>,
    <>
      <strong className="text-foreground">Connect your AI client.</strong> Open
      Claude → Customize → Connectors → &quot;+&quot; → paste{" "}
      <code>https://finlynq.com/mcp</code>. OAuth handles the rest. For
      self-host, point Claude at your own deployment&apos;s <code>/mcp</code>{" "}
      URL. This is the part Mint never had.
    </>,
  ],
  faq: [
    {
      q: "Is Mint still available?",
      a: (
        <>
          No. Intuit discontinued Mint on March 23, 2024 and directed users to
          Credit Karma (also owned by Intuit). Credit Karma shows account
          balances and a credit score, but it doesn&apos;t do budgeting,
          net-worth tracking, or portfolio tracking the way Mint did, so most
          former Mint users are still looking for a real replacement.
        </>
      ),
    },
    {
      q: "What's the best free alternative to Mint?",
      a: (
        <>
          If &quot;free&quot; means self-hosted, Finlynq is free forever under
          AGPL v3: run it on your own hardware with Docker and PostgreSQL and
          you pay nothing. If you&apos;d rather not manage a server, the hosted
          cloud is donation-based with the same features. Unlike Mint, there
          are no ads and no financial products being sold to you, because that
          isn&apos;t how Finlynq is funded.
        </>
      ),
    },
    {
      q: "Is Credit Karma a good Mint replacement?",
      a: (
        <>
          Not for budgeting. Credit Karma is built around credit scores and
          product recommendations, not budgets, net worth, or investment
          tracking. If you liked Mint for seeing all your accounts, categorizing
          spending, and tracking net worth over time, Credit Karma won&apos;t
          feel like a replacement. A dedicated PFM like Finlynq will.
        </>
      ),
    },
    {
      q: "Can I import my old Mint data into Finlynq?",
      a: (
        <>
          Yes, if you have a CSV. Finlynq&apos;s import pipeline at{" "}
          <code>/import</code> accepts CSV and OFX files with a staging-review
          step that maps columns, flags duplicates, and detects transfer pairs
          before anything is committed. If you never exported before Mint shut
          down, you can rebuild your history from bank statement downloads
          instead.
        </>
      ),
    },
    {
      q: "Is there a self-hosted Mint alternative?",
      a: (
        <>
          Yes. Finlynq is designed to be self-hosted: one Docker Compose file, a
          PostgreSQL database, and you own the whole thing. Your transaction
          notes, payees, tags, and account names are encrypted per-user with a
          key derived from your password, so even you-as-the-operator
          can&apos;t read them without logging in. That&apos;s a stronger
          privacy posture than Mint ever offered.
        </>
      ),
    },
    {
      q: "Why did Mint shut down, and could that happen to Finlynq?",
      a: (
        <>
          Intuit closed Mint to consolidate users into Credit Karma. That risk
          is inherent to any free, closed, ad-funded product: it exists only as
          long as the owner finds it strategically worth running. Finlynq is
          structurally different: it&apos;s AGPL v3, so the code and your data
          are always yours, and it&apos;s donation-funded with no investors to
          answer to. Even if the hosted cloud ever went away, you could keep
          running your own instance.
        </>
      ),
    },
  ],
  sources: [
    {
      label: "Intuit Mint shutdown notice",
      href: "https://www.mint.com/",
      note: "Mint discontinued March 23, 2024",
    },
    {
      label: "Credit Karma (Mint's successor)",
      href: "https://www.creditkarma.com/",
      note: "credit + balances, not a budgeting tool",
    },
    {
      label: "Finlynq on GitHub",
      href: "https://github.com/finlynq/finlynq",
      note: "AGPL v3 source",
    },
    {
      label: "Finlynq MCP guide",
      href: "/mcp-guide",
      note: "current tool counts + connect-to-Claude instructions",
    },
  ],
  lastUpdated: "2026-07-05",
};

export default function VsMintPage() {
  return <VsPage content={content} />;
}
