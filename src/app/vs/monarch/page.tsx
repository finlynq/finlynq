import type { Metadata } from "next";
import { VsPage, type VsPageContent } from "../_components/VsPage";

export const metadata: Metadata = {
  title: "Finlynq vs Monarch Money — open-source AI-native alternative",
  description:
    "Finlynq vs Monarch Money: open-source AGPL v3 with self-host + 102 MCP tools + per-user envelope encryption + Canadian tax accounts, compared against Monarch's closed-source hosted SaaS with full Plaid bank sync and household budgeting. Side-by-side feature table, when to choose each, and migration steps.",
  alternates: {
    canonical: "/vs/monarch",
  },
  openGraph: {
    title: "Finlynq vs Monarch Money — open-source AI-native alternative",
    description:
      "Two AI-native PFMs, compared. Monarch: closed-source SaaS, $99/yr, Plaid bank sync, household plan. Finlynq: AGPL v3, self-hostable, 102 MCP tools, per-user envelope encryption, RRSP/TFSA tracking.",
    url: "/vs/monarch",
    siteName: "Finlynq",
    type: "article",
  },
  twitter: {
    card: "summary_large_image",
    title: "Finlynq vs Monarch Money — open-source AI-native alternative",
    description:
      "Open-source self-hostable PFM with 102 MCP tools and per-user envelope encryption, compared with Monarch Money's closed SaaS.",
  },
};

const content: VsPageContent = {
  competitorName: "Monarch Money",
  slug: "monarch",
  tagline: (
    <>
      Monarch is the polished hosted SaaS that absorbed most of Mint&apos;s
      audience after the 2024 shutdown. Finlynq is the open-source,
      self-hostable, AI-native alternative — same MCP-driven workflows Monarch
      is now building, but with your data on your hardware and your encryption
      keys derived from your password.
    </>
  ),
  whenCompetitor: [
    <>
      <strong className="text-foreground">
        You want zero-config bank sync across thousands of US institutions.
      </strong>{" "}
      Monarch&apos;s Plaid + MX + Finicity aggregator coverage is the category
      benchmark; Finlynq is file / email / CSV / OFX import today, with SnapTrade
      brokerage integration on the roadmap.
    </>,
    <>
      <strong className="text-foreground">
        You want a polished native iOS and Android app.
      </strong>{" "}
      Monarch&apos;s mobile apps are mature with receipt scanning, push
      notifications, and quick add. Finlynq has a React Native Expo app for
      Dashboard, Transactions, Import, Budgets, and Settings — functional but
      not at parity.
    </>,
    <>
      <strong className="text-foreground">
        You want shared household / couples finances built in.
      </strong>{" "}
      Monarch&apos;s two-person household plan with collaborative budgets,
      shared net worth, and partner-level visibility is a category-leading
      feature. Finlynq is single-user today.
    </>,
    <>
      <strong className="text-foreground">
        You want a fully-staffed support team.
      </strong>{" "}
      Monarch has live chat and a dedicated customer-success org. Finlynq is
      community-supported via GitHub issues and a Discord.
    </>,
    <>
      <strong className="text-foreground">
        You don&apos;t want to think about Postgres, Docker, encryption keys, or
        password recovery.
      </strong>{" "}
      Monarch is hosted; that&apos;s the whole pitch. Finlynq also has a hosted
      option at <code>finlynq.com/cloud</code>, but the project&apos;s center of
      gravity is self-host.
    </>,
  ],
  whenFinlynq: [
    <>
      <strong className="text-foreground">You want the source code.</strong>{" "}
      Finlynq is AGPL v3, fully on GitHub. Monarch is closed-source — you
      can&apos;t audit the categorization rules, the AI features, the
      encryption claims, or what data leaves your account.
    </>,
    <>
      <strong className="text-foreground">You want to self-host.</strong>{" "}
      Finlynq runs on your hardware via Docker + PostgreSQL with the same
      feature set as the managed cloud. Monarch cannot be self-hosted at any
      price.
    </>,
    <>
      <strong className="text-foreground">
        You want per-user encryption with keys derived from your password.
      </strong>{" "}
      Finlynq&apos;s envelope encryption (AES-256-GCM with scrypt-derived KEK)
      means even the operator cannot read your transaction notes, payees, tags,
      or display names on the 6 in-scope tables. Monarch&apos;s {`"`}AES-256 at
      rest{`"`} is a blanket infrastructure claim; the operator holds the keys.
    </>,
    <>
      <strong className="text-foreground">
        You want a first-party MCP server with 102 HTTP / 93 stdio tools.
      </strong>{" "}
      Finlynq ships MCP as a core feature, not a bolt-on — OAuth 2.1 + DCR,
      Bearer API keys, stdio, all transports. Monarch did add an MCP server in
      2026, but Finlynq&apos;s surface is 3× larger and was built from day one
      for AI assistants rather than retrofitted to a consumer SaaS.
    </>,
    <>
      <strong className="text-foreground">
        You want Canadian tax accounts done right.
      </strong>{" "}
      Finlynq&apos;s <code>tax-optimizer.ts</code> ships RRSP / TFSA / RESP
      contribution-room tracking with CRA-published limits and asset-location
      advice (bonds in RRSP, stocks in TFSA). Monarch is US-tax-account-centric.
    </>,
    <>
      <strong className="text-foreground">
        You&apos;re paying ~$100/year and would rather not.
      </strong>{" "}
      Monarch is $14.99/month or $99.99/year. Finlynq is donation-based — same
      features whether you self-host for free or use the hosted cloud.
    </>,
    <>
      <strong className="text-foreground">
        You want to own your data on the day Monarch raises a new round, pivots,
        or shuts down.
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
      label: "Pricing",
      finlynq: "Donation-based; same features either way",
      competitor: "$14.99/mo or $99.99/yr (after 7-day trial)",
    },
    {
      label: "First-party MCP",
      finlynq: (
        <>
          Yes —{" "}
          <strong className="text-foreground">102 HTTP / 93 stdio</strong> tools,
          v3.2.0
        </>
      ),
      competitor: "Yes — Monarch MCP server (added 2026, smaller surface)",
    },
    {
      label: "MCP auth",
      finlynq: "OAuth 2.1 + DCR, Bearer API key, or stdio",
      competitor: "OAuth-scoped permissions",
    },
    {
      label: "REST / HTTP API",
      finlynq: "Yes — full surface mirrored from MCP",
      competitor: "Limited public API",
    },
    {
      label: "Bank sync (US)",
      finlynq:
        "File / email / CSV / OFX import + connector framework. No first-party Plaid today.",
      competitor: "Plaid + MX + Finicity — full aggregator coverage",
    },
    {
      label: "Bank sync (Canada)",
      finlynq: "Same as US — file/email import; SnapTrade brokerage on roadmap",
      competitor: "Limited — Plaid Canada coverage is partial",
    },
    {
      label: "Native mobile app",
      finlynq:
        "React Native (Expo) — Dashboard, Tx, Import, Budgets, Settings",
      competitor: "iOS + Android (mature)",
    },
    {
      label: "Multi-user / household",
      finlynq: "No (single-user)",
      competitor:
        "Yes — two-person household plan with shared budgets + net worth",
    },
    {
      label: "In-app AI chat",
      finlynq: "Yes — built into the UI, no MCP client setup required",
      competitor: "Yes — AI assistant added in 2025",
    },
    {
      label: "Encryption at rest",
      finlynq:
        "Per-user envelope encryption: AES-256-GCM with scrypt-derived KEK. Operator cannot decrypt user-scoped fields.",
      competitor: `"AES-256 at rest" — Monarch holds the keys`,
    },
    {
      label: "Cash-flow forecasting",
      finlynq: "Yes — projects 30/60/90 days from recurring transactions",
      competitor: "Yes — flagship feature",
    },
    {
      label: "Spending anomaly detection",
      finlynq: "Yes — flags categories 30%+ above 3-month average",
      competitor: "Yes — weekly recap",
    },
    {
      label: "Net-worth tracking",
      finlynq: "Yes",
      competitor: "Yes",
    },
    {
      label: "Investment / portfolio",
      finlynq:
        "Cost basis (lot-tracked), dividends, FX-aware aggregation, RRSP/TFSA/RESP contribution-room tracking",
      competitor:
        "Holdings + performance via aggregators; US-centric tax accounts",
    },
    {
      label: "Canadian tax accounts",
      finlynq:
        "RRSP, TFSA, RESP via contribution_room table + tax-optimizer.ts with CRA limits",
      competitor: "Limited — US-centric",
    },
    {
      label: "Multi-currency",
      finlynq:
        "Native, with per-currency cost-basis bucketing and historical FX lookups",
      competitor: "Limited multi-currency support",
    },
    {
      label: "Funding",
      finlynq: "Bootstrapped, donations",
      competitor: "$9.4M Series A (Accel, ~2023)",
    },
    {
      label: "Revenue model",
      finlynq: "Donations",
      competitor: "Subscriptions",
    },
  ],
  migrationSteps: [
    <>
      <strong className="text-foreground">
        Export your Monarch transactions.
      </strong>{" "}
      Monarch supports CSV export from the web app (Settings → Data → Export).
      Multi-account exports are one CSV per account.
    </>,
    <>
      <strong className="text-foreground">Import into Finlynq.</strong> Upload
      each CSV at <code>/import/reconcile</code>. The staging-review pipeline
      handles multi-currency, transfer-pair detection, and dedup. Approve once
      you&apos;ve reviewed.
    </>,
    <>
      <strong className="text-foreground">Re-create your budgets.</strong>{" "}
      Monarch&apos;s budget categories don&apos;t auto-import. Use
      Finlynq&apos;s budget UI (or the <code>set_budget</code> MCP tool) to
      re-author your most-used categories.
    </>,
    <>
      <strong className="text-foreground">
        Re-create your auto-categorize rules.
      </strong>{" "}
      Same story — re-author via the rules UI at <code>/settings/rules</code>{" "}
      or via the <code>create_rule</code> MCP tool.
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
      q: "Isn't Monarch obviously better — it has bank sync, native mobile, and household features Finlynq doesn't?",
      a: (
        <>
          For users whose top priorities are auto-sync, mobile polish, and
          shared household budgeting on US banks, yes — Monarch is the better
          default. Finlynq&apos;s audience is users who specifically want open
          source, self-hosting, per-user encryption that excludes the operator,
          and a deeper MCP surface — and who are willing to trade Plaid
          convenience for those properties.
        </>
      ),
    },
    {
      q: "Monarch has an MCP server now too. Doesn't that close Finlynq's main gap?",
      a: (
        <>
          It narrows it but doesn&apos;t close it. Finlynq&apos;s MCP is 102 HTTP
          / 93 stdio tools at v3.2.0, built from day one as a first-party surface
          with OAuth 2.1 + DCR, stdio transport, and per-user encryption.
          Monarch&apos;s MCP is a 2026 addition layered on top of a closed-source
          SaaS — useful, but the underlying data still lives on Monarch&apos;s
          infrastructure, the operator can read everything, and you can&apos;t
          audit the tool implementations.
        </>
      ),
    },
    {
      q: "Why would I trust an open-source PFM over a funded SaaS?",
      a: (
        <>
          That&apos;s the right question. Finlynq&apos;s answer: structural
          (AGPL means you can leave with all your code and data; encryption
          means even we can&apos;t read your transactions if you self-host;
          donation model means we can&apos;t be acquired and pivoted) rather
          than reputational. Monarch&apos;s answer is brand and capital. Pick
          the one whose argument you trust more.
        </>
      ),
    },
    {
      q: "Does Finlynq have couples / household support?",
      a: (
        <>
          Not yet. It&apos;s a tracked design item — the envelope-encryption
          model assumed a single user, so adding shared accounts is a
          non-trivial cryptographic design. If household is a hard requirement,
          Monarch is ahead until Finlynq ships it.
        </>
      ),
    },
    {
      q: "How does the AI experience compare?",
      a: (
        <>
          Both have in-app AI chat. The differentiation: Finlynq&apos;s MCP is
          exposed to <em>any</em> MCP-compatible client (Claude, Cursor,
          Windsurf, custom agents), so you can run the same queries from your
          preferred AI workflow. Monarch&apos;s AI is in-app only.
        </>
      ),
    },
    {
      q: "Can I run both?",
      a: (
        <>
          Yes, plenty of people do — Monarch for bank sync + household, Finlynq
          as a parallel system with encryption + MCP. Export from Monarch to
          CSV, import to Finlynq for the data you want under your own control.
        </>
      ),
    },
  ],
  sources: [
    {
      label: "Monarch Money homepage",
      href: "https://www.monarchmoney.com/",
      note: "fetched 2026-05-27",
    },
    {
      label: "Monarch pricing",
      href: "https://www.monarchmoney.com/pricing",
      note: "$14.99/mo or $99.99/yr",
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
  lastUpdated: "2026-05-27",
};

export default function VsMonarchPage() {
  return <VsPage content={content} />;
}
