import type { Metadata } from "next";
import { VsPage, type VsPageContent } from "../_components/VsPage";

export const metadata: Metadata = {
  title:
    "Finlynq vs Firefly III — open-source personal finance with first-party MCP",
  description:
    "Finlynq vs Firefly III: two AGPL v3 self-hostable personal finance apps. Firefly III is mature double-entry accounting with PSD2 bank sync; Finlynq is UI + first-party MCP (91 HTTP / 87 stdio tools) with per-user envelope encryption. Side-by-side feature table, when to choose each, and migration steps.",
  alternates: {
    canonical: "https://finlynq.com/vs/firefly-iii",
  },
  openGraph: {
    title:
      "Finlynq vs Firefly III — open-source personal finance with first-party MCP",
    description:
      "Two AGPL v3 self-hostable PFMs, compared. Firefly III: 11-year-old double-entry, PSD2 bank sync, no first-party MCP. Finlynq: first-party MCP server with 91 HTTP / 87 stdio tools, per-user envelope encryption, native investment tracking.",
    url: "https://finlynq.com/vs/firefly-iii",
    siteName: "Finlynq",
    type: "article",
  },
  twitter: {
    card: "summary_large_image",
    title:
      "Finlynq vs Firefly III — open-source personal finance with first-party MCP",
    description:
      "AGPL v3 self-hostable PFMs compared. Firefly III's double-entry rigor + PSD2 vs Finlynq's first-party MCP (91 HTTP / 87 stdio) and per-user envelope encryption.",
  },
};

const content: VsPageContent = {
  competitorName: "Firefly III",
  slug: "firefly-iii",
  tagline: (
    <>
      Firefly III is the canonical open-source self-hosted PFM — eleven years
      old, AGPL v3, 23k+ stars, 10M+ Docker pulls, and a deep double-entry
      accounting model. Finlynq is also AGPL v3 and self-hostable, but built
      around a first-party MCP server and per-user encryption rather than a
      strict double-entry ledger. They serve overlapping but distinct audiences.
    </>
  ),
  whenCompetitor: [
    <>
      <strong className="text-foreground">
        You want a true double-entry accounting model.
      </strong>{" "}
      Every Firefly III transaction is a transfer between two accounts (asset /
      expense / revenue / liability) — accountant-grade rigor. Finlynq is
      single-entry with derived transfer pairs (<code>link_id</code>), which is
      lighter but doesn&apos;t enforce balance.
    </>,
    <>
      <strong className="text-foreground">
        You want a battle-tested rule engine.
      </strong>{" "}
      Firefly III&apos;s rule groups, triggers, actions, and {`"`}replay over
      historical transactions{`"`} UX are more mature than Finlynq&apos;s
      auto-categorize rules.
    </>,
    <>
      <strong className="text-foreground">
        You&apos;re in the EU/UK and want first-party PSD2 bank aggregation.
      </strong>{" "}
      Firefly III&apos;s Data Importer ships GoCardless / Nordigen (free PSD2
      access) and Salt Edge integrations. Finlynq has no first-party Plaid or
      PSD2 aggregator integration today.
    </>,
    <>
      <strong className="text-foreground">
        You want the largest, longest-running OSS PFM community.
      </strong>{" "}
      ~23.2k GitHub stars, 10M+ Docker pulls, hundreds of contributors since
      2015. Finlynq is brand new by comparison.
    </>,
    <>
      <strong className="text-foreground">
        You want multi-user on one instance.
      </strong>{" "}
      Firefly III supports admin / demo / regular roles on a single deployment.
      Finlynq is single-user.
    </>,
    <>
      <strong className="text-foreground">
        You prefer PHP/Laravel + LAMP hosting.
      </strong>{" "}
      Firefly III runs on any shared host with PHP 8.x. Finlynq&apos;s Node +
      PostgreSQL stack is heavier.
    </>,
  ],
  whenFinlynq: [
    <>
      <strong className="text-foreground">
        You want a first-party MCP server.
      </strong>{" "}
      Finlynq ships <strong className="text-foreground">91 HTTP and 87 stdio</strong>{" "}
      MCP tools built and maintained by the project, with OAuth 2.1 + Dynamic
      Client Registration, Bearer API keys, and stdio transports. Firefly III
      has <strong className="text-foreground">no first-party MCP server</strong>{" "}
      — its maintainer closed{" "}
      <a
        href="https://github.com/firefly-iii/firefly-iii/issues/9753"
        target="_blank"
        rel="noreferrer noopener"
        className="underline underline-offset-2 hover:text-primary"
      >
        issue #9753
      </a>{" "}
      ({`"`}LLM integration for auto-categorization & advanced reporting{`"`})
      with no plan to add one. Two community-built MCP wrappers exist that call
      Firefly III&apos;s REST API with a Personal Access Token; they aren&apos;t
      blessed by the project, aren&apos;t integrated into the UI, and depend on
      whatever access the user&apos;s REST token has.
    </>,
    <>
      <strong className="text-foreground">
        You want per-user envelope encryption of names, payees, notes, and
        tags.
      </strong>{" "}
      Finlynq wraps a per-user DEK with a scrypt-derived KEK keyed off your
      password (AES-256-GCM with a <code>v1:</code> envelope). Even the operator
      can&apos;t read your transaction notes, payees, tags, or display names.
      Firefly III stores those fields plaintext in the database; row-level
      encryption is the operator&apos;s responsibility.
    </>,
    <>
      <strong className="text-foreground">
        You want native investment / portfolio tracking.
      </strong>{" "}
      Finlynq has cost basis, dividends, FX-aware aggregation across accounts,
      and per-currency cost-basis bucketing. Firefly III has no native concept
      of holdings, prices, or portfolio P/L — long-standing community gap.
    </>,
    <>
      <strong className="text-foreground">
        You want a managed cloud option.
      </strong>{" "}
      Finlynq has both a free Docker self-host path and{" "}
      <code>finlynq.com/cloud</code> (same features). Firefly III is self-host
      only by design.
    </>,
    <>
      <strong className="text-foreground">
        You want a modern App Router UI.
      </strong>{" "}
      Finlynq is Next.js 16 + Tailwind + shadcn/ui v4. Firefly III is
      server-rendered Laravel Blade with progressively enhanced JS —
      boring-stable but visibly older.
    </>,
    <>
      <strong className="text-foreground">You&apos;re North American.</strong>{" "}
      Firefly III&apos;s bank-aggregation story is EU-PSD2 centric; NA users
      almost always CSV import. Finlynq&apos;s connector framework + email-import
      staging is more flexible for NA institutions today.
    </>,
  ],
  comparisonRows: [
    {
      label: "License",
      finlynq: "AGPL v3",
      competitor: "AGPL v3",
    },
    {
      label: "Founded",
      finlynq: "2026",
      competitor: "2015",
    },
    {
      label: "GitHub stars",
      finlynq: "New project",
      competitor: "~23.2k",
    },
    {
      label: "Docker pulls",
      finlynq: "New project",
      competitor: (
        <>
          10M+ on <code>fireflyiii/core</code>
        </>
      ),
    },
    {
      label: "Hosting",
      finlynq: "Self-host (Docker + PostgreSQL) or managed cloud",
      competitor: "Self-host only (Docker + LAMP)",
    },
    {
      label: "Pricing",
      finlynq: "Donation-based; same features on self-host and managed cloud",
      competitor: "Donation-based (GitHub Sponsors, Patreon)",
    },
    {
      label: "First-party MCP server",
      finlynq: (
        <>
          Yes —{" "}
          <strong className="text-foreground">91 HTTP / 87 stdio</strong> tools,
          v3.1.0
        </>
      ),
      competitor: (
        <>
          No — maintainer-declined (
          <a
            href="https://github.com/firefly-iii/firefly-iii/issues/9753"
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2 hover:text-primary"
          >
            #9753
          </a>
          )
        </>
      ),
    },
    {
      label: "Community MCP wrappers",
      finlynq: "n/a (first-party)",
      competitor: (
        <>
          Two unofficial: <code>etnperlong/firefly-iii-mcp</code> (TS, ~69★) and{" "}
          <code>horsfallnathan/firefly-iii-mcp-server</code> (Python, ~7★)
        </>
      ),
    },
    {
      label: "MCP auth",
      finlynq: (
        <>
          OAuth 2.1 + DCR, Bearer API key (<code>pf_*</code>), or stdio
        </>
      ),
      competitor: "Community wrappers proxy a Firefly Personal Access Token",
    },
    {
      label: "REST / HTTP API",
      finlynq: "Yes — full surface mirrored from MCP",
      competitor: "Yes — covers almost the whole app; OAuth 2 + PAT",
    },
    {
      label: "Accounting model",
      finlynq: (
        <>
          Single-entry with server-minted transfer-pair <code>link_id</code>s
        </>
      ),
      competitor:
        "Double-entry (every txn is asset↔expense / asset↔asset etc.)",
    },
    {
      label: "Multi-currency",
      finlynq: "Native, with per-currency cost-basis bucketing",
      competitor: "Native; per-account currency + stored FX rate per txn",
    },
    {
      label: "Investment / portfolio",
      finlynq:
        "Cost basis, dividends, FX-aware aggregation across accounts",
      competitor:
        "Not natively supported — community workaround via asset accounts",
    },
    {
      label: "Bank sync",
      finlynq:
        "File / email import + connector framework. No first-party Plaid / PSD2 yet.",
      competitor:
        "Data Importer: CSV, OFX, camt.053, GoCardless / Nordigen (PSD2 EU), Salt Edge, Spectre",
    },
    {
      label: "Rule engine",
      finlynq: "Auto-categorize rules (match field / type / value)",
      competitor:
        "Rule groups, triggers, actions, replay over history — deeper",
    },
    {
      label: "Encryption at rest",
      finlynq:
        "Per-user envelope encryption (AES-256-GCM, scrypt-derived KEK from password) — operator cannot decrypt",
      competitor:
        "Plaintext at the application layer; row encryption is the operator's responsibility",
    },
    {
      label: "Multi-user / household",
      finlynq: "No (single-user)",
      competitor: "Yes — admin / demo / regular roles on one instance",
    },
    {
      label: "Native mobile app",
      finlynq: "No (mobile web UI only)",
      competitor: "No (mobile web UI only)",
    },
    {
      label: "Localization",
      finlynq: "English only at launch",
      competitor: "Widely translated — strong i18n (EU origin)",
    },
    {
      label: "Stack",
      finlynq: "Next.js 16, TypeScript, Drizzle, PostgreSQL",
      competitor:
        "Laravel (PHP 8.x), Blade + Vue 3, MySQL/MariaDB/PostgreSQL/SQLite",
    },
    {
      label: "Anthropic Connectors Directory",
      finlynq: "Submitted 2026-05-09; awaiting review",
      competitor: "Not listed",
    },
  ],
  migrationSteps: [
    <>
      <strong className="text-foreground">Export transactions.</strong> Use
      Firefly III&apos;s built-in CSV export from{" "}
      <code>Profile → Export data</code>, or hit the{" "}
      <code>/api/v1/transactions</code> endpoint with a Personal Access Token
      and a paginated date range.
    </>,
    <>
      <strong className="text-foreground">
        Flatten double-entry pairs into single-entry.
      </strong>{" "}
      Each Firefly III double-entry transaction becomes one row in Finlynq with
      a signed amount. Transfers between two of your asset accounts will land
      in Finlynq&apos;s staging UI; mark them as transfer pairs on{" "}
      <code>/import/pending</code> and Finlynq mints a server-side{" "}
      <code>link_id</code>.
    </>,
    <>
      <strong className="text-foreground">Import into Finlynq.</strong> Upload
      the CSV at <code>/import/reconcile</code>. The unified staging pipeline
      lets you review, edit, and approve every row — multi-currency,
      transfer-pair detection, and dedup are built in.
    </>,
    <>
      <strong className="text-foreground">Re-create your rules.</strong>{" "}
      Firefly III&apos;s rule groups don&apos;t auto-import. Use Finlynq&apos;s{" "}
      <code>create_rule</code> (web UI or MCP tool) to re-author your most-used
      rules; {`"`}match field / match type / match value{`"`} maps cleanly to
      Firefly III&apos;s simpler triggers.
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
      q: "Isn't Firefly III strictly better since it's older and more popular?",
      a: (
        <>
          For traditional double-entry budgeting workflows on EU/UK banking
          infrastructure, often yes — Firefly III has eleven years of polish, a
          deep rule engine, PSD2 bank aggregation, and multi-user support.
          Finlynq is built for a different slot: AI-native users who want a
          first-party MCP server, encryption that excludes the operator, and
          native investment tracking. We pick different fights.
        </>
      ),
    },
    {
      q: "Why doesn't Firefly III just add MCP?",
      a: (
        <>
          The maintainer (JC5) closed the LLM-integration request without plans
          to ship it (
          <a
            href="https://github.com/firefly-iii/firefly-iii/issues/9753"
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2 hover:text-primary"
          >
            issue #9753
          </a>
          ). That&apos;s a legitimate product call — Firefly III&apos;s identity
          is opinionated double-entry accounting, not AI. Two community wrappers
          exist that proxy the REST API; they work, but they aren&apos;t
          blessed, aren&apos;t in-UI, and they expose whatever a Firefly III
          Personal Access Token can access.
        </>
      ),
    },
    {
      q: "Are the community MCP wrappers for Firefly III as good as Finlynq's MCP?",
      a: (
        <>
          They cover a useful slice — accounts, bills, categories, tags,
          transactions, search, budgets — but they&apos;re external Node /
          Python processes calling Firefly III&apos;s REST API with a Personal
          Access Token. There&apos;s no per-user envelope encryption, no
          confirmation-token preview/execute pattern for destructive ops, no
          OAuth 2.1 + DCR, and no first-party support. Finlynq&apos;s MCP is
          part of the project (91 HTTP / 87 stdio tools at v3.1.0, the canonical{" "}
          <code>{`{ success: true, data: <T> }`}</code> envelope, tool
          annotations for the Anthropic Connectors Directory, per-user
          encryption all the way through).
        </>
      ),
    },
    {
      q: "Does Firefly III have better bank-sync than Finlynq?",
      a: (
        <>
          In the EU/UK — yes, materially. Firefly III&apos;s Data Importer ships
          GoCardless / Nordigen (free PSD2 access) and Salt Edge. In North
          America — both projects largely rely on CSV / OFX / QFX import;
          neither ships Plaid out of the box. Finlynq&apos;s email-import
          staging via Resend Inbound is a different angle that some users
          prefer.
        </>
      ),
    },
    {
      q: "Does Finlynq do double-entry?",
      a: (
        <>
          No. Finlynq is single-entry: every transaction has one signed amount
          on one account. Transfer pairs are modelled as two rows linked by a
          server-minted <code>link_id</code> with a four-check invariant
          (link_id present, sole sibling, both <code>type=&apos;R&apos;</code>,
          different accounts). That&apos;s enough for the workflows Finlynq
          targets, but it&apos;s not accountant-grade. If you want a
          balance-enforcing ledger, Firefly III (or hledger / Beancount /
          Actual) is the better tool.
        </>
      ),
    },
    {
      q: "How do the encryption stories compare?",
      a: (
        <>
          Firefly III stores names, payees, notes, and tags as plaintext
          columns and relies on the operator&apos;s database-at-rest encryption
          (whatever the operator configured). Finlynq encrypts those fields at
          the application layer with a per-user DEK that&apos;s wrapped by a
          scrypt-derived KEK keyed off the user&apos;s password (peppered with{" "}
          <code>PF_PEPPER</code>). Even with full DB access, the operator
          can&apos;t read user-scoped fields. The trade-off: lose your Finlynq
          password without a backup → those fields are unrecoverable. Firefly
          III is simpler operationally, Finlynq is stronger structurally.
        </>
      ),
    },
    {
      q: "Can I run both?",
      a: (
        <>
          Yes, plenty of people do. Firefly III is a great primary ledger;
          Finlynq can be a parallel system for users who want an MCP-driven
          copy of their data in a Postgres they control, with envelope
          encryption and native investment tracking. Until Finlynq adds
          bank-sync parity, this is a reasonable hybrid.
        </>
      ),
    },
  ],
  sources: [
    {
      label: "Firefly III on GitHub",
      href: "https://github.com/firefly-iii/firefly-iii",
      note: "~23.2k stars, AGPL v3",
    },
    {
      label: "Firefly III Docker image",
      href: "https://hub.docker.com/r/fireflyiii/core",
      note: "10M+ pulls",
    },
    {
      label: "Firefly III docs",
      href: "https://docs.firefly-iii.org",
      note: "official docs, REST API + Data Importer",
    },
    {
      label: "Firefly III #9753 — LLM integration request",
      href: "https://github.com/firefly-iii/firefly-iii/issues/9753",
      note: "closed without plans to ship",
    },
    {
      label: "etnperlong/firefly-iii-mcp",
      href: "https://github.com/etnperlong/firefly-iii-mcp",
      note: "community MCP wrapper (TypeScript)",
    },
    {
      label: "horsfallnathan/firefly-iii-mcp-server",
      href: "https://github.com/horsfallnathan/firefly-iii-mcp-server",
      note: "community MCP wrapper (Python)",
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
  lastUpdated: "2026-05-13",
};

export default function VsFireflyIiiPage() {
  return <VsPage content={content} />;
}
