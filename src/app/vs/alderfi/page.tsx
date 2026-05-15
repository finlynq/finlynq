import type { Metadata } from "next";
import { VsPage, type VsPageContent } from "../_components/VsPage";

export const metadata: Metadata = {
  title:
    "Finlynq vs Alderfi — two open-source MCP-first personal finance apps",
  description:
    "Finlynq vs Alderfi: production-ready AGPL v3 PFM with 91 MCP tools, hosted demo, per-user envelope encryption, and multi-currency support — compared with Alderfi's pre-alpha Apache-2.0 project that ships local LLM (Llama 3 via llama.cpp). Side-by-side feature table, when to choose each, dated 2026-05-13.",
  alternates: {
    canonical: "https://finlynq.com/vs/alderfi",
  },
  openGraph: {
    title:
      "Finlynq vs Alderfi — two open-source MCP-first personal finance apps",
    description:
      "Two open-source MCP-first PFMs, honestly compared. Finlynq: AGPL v3, production, 91 MCP tools, hosted + self-host, per-user encryption. Alderfi: Apache-2.0, pre-alpha, local LLM via llama.cpp.",
    url: "https://finlynq.com/vs/alderfi",
    siteName: "Finlynq",
    type: "article",
  },
  twitter: {
    card: "summary_large_image",
    title:
      "Finlynq vs Alderfi — two open-source MCP-first personal finance apps",
    description:
      "AGPL v3 production PFM with 91 MCP tools vs Apache-2.0 pre-alpha with local LLM. Pick the one that matches your trade-offs.",
  },
};

const content: VsPageContent = {
  competitorName: "Alderfi",
  slug: "alderfi",
  tagline: (
    <>
      Alderfi and Finlynq are both open-source, MCP-first personal finance
      projects. Alderfi is Apache-2.0, pre-alpha, and ships local LLM support
      out of the box. Finlynq is AGPL v3, production, hosted-or-self-hosted,
      with a 91-tool MCP surface. This page exists so you can pick the one that
      actually matches your trade-offs.
    </>
  ),
  whenCompetitor: [
    <>
      <strong className="text-foreground">
        You need a permissive license.
      </strong>{" "}
      Apache-2.0 has a patent grant and no copyleft, so you can wrap Alderfi in
      a closed-source product, ship a SaaS without sharing changes, or vendor
      it into a regulated stack without AGPL §13&apos;s source-disclosure
      trigger. Finlynq&apos;s AGPL v3 deliberately forces network forks to
      publish their changes — that&apos;s a feature for the maintainer and a
      friction for users who specifically want Apache.
    </>,
    <>
      <strong className="text-foreground">
        You want a local-LLM-first privacy story.
      </strong>{" "}
      Alderfi documents Llama 3 8B via llama.cpp as part of its categorization
      pipeline. If your threat model is{" "}
      {`"`}no third party — including Anthropic or OpenAI — sees my financial
      transactions,{`"`} Alderfi&apos;s posture matches that. Finlynq today
      assumes you connect a cloud LLM (Claude, ChatGPT, Cursor, Windsurf) over
      MCP; we don&apos;t ship a local-LLM mode.
    </>,
    <>
      <strong className="text-foreground">
        You want to follow a project from day one.
      </strong>{" "}
      Alderfi is openly pre-alpha and is being designed in public. If the
      appeal is shaping the architecture, naming the abstractions, and being
      one of the first contributors, an alpha project is exactly where to be.
    </>,
    <>
      <strong className="text-foreground">
        {`"`}The app is the MCP server{`"`} is the framing you want.
      </strong>{" "}
      Alderfi positions MCP as the core abstraction, not a layer over a
      traditional PFM. That&apos;s a cleaner architectural pitch than
      Finlynq&apos;s {`"`}PFM with first-party MCP{`"`} framing.
    </>,
  ],
  whenFinlynq: [
    <>
      <strong className="text-foreground">
        You want something you can use today.
      </strong>{" "}
      Finlynq is shipped: hosted at finlynq.com with a public demo (
      <code>demo@finlynq.com</code> / <code>finlynq-demo</code>, resets nightly)
      and an installable Docker + PostgreSQL stack for self-hosters.
      Alderfi&apos;s first alpha targets mid-May 2026 and the current public
      repo is a scaffold with one mock tool.
    </>,
    <>
      <strong className="text-foreground">
        You want a hosted option, with parity to self-host.
      </strong>{" "}
      Finlynq runs as both a managed cloud and a self-hosted Docker deployment
      with identical feature surfaces. Alderfi is self-host only today; the
      planned paid hosted tier is a separate product.
    </>,
    <>
      <strong className="text-foreground">
        You want a large, audited MCP tool surface today.
      </strong>{" "}
      Finlynq exposes <strong className="text-foreground">91 HTTP / 87 stdio</strong>{" "}
      tools across accounts, transactions, budgets, categories, rules, portfolio
      (cost basis, dividends, FX-aware aggregation), goals, loans,
      subscriptions, recurring transactions, FX with overrides, spending
      anomalies, FIRE-style cash flow forecasting, and staging-review imports.
      Alderfi&apos;s tool surface today is 1 mock tool.
    </>,
    <>
      <strong className="text-foreground">
        You want per-user encryption at rest with operator-unreadable keys.
      </strong>{" "}
      Finlynq&apos;s envelope encryption (AES-256-GCM with a scrypt-derived KEK
      peppered with <code>PF_PEPPER</code>) means even the operator running
      finlynq.com cannot decrypt account names, payees, notes, or tags.
      Alderfi&apos;s encryption-at-rest posture isn&apos;t publicly documented
      as of 2026-05-13.
    </>,
    <>
      <strong className="text-foreground">
        You need real-world import paths.
      </strong>{" "}
      Finlynq&apos;s unified staging-review pipeline ingests CSV, Excel, PDF,
      OFX/QFX, and email-via-Resend-Inbound into the same{" "}
      <code>staged_imports</code> table, with per-row editing, transfer-pair
      linking, dedup via SHA-256 over plaintext payee, and a statement-balance
      reconciliation callout. Alderfi documents CSV + SimpleFIN today.
    </>,
    <>
      <strong className="text-foreground">You need multi-currency.</strong>{" "}
      Finlynq supports 32 fiats + 4 cryptos + 4 metals, with per-currency
      cost-basis bucketing for portfolio holdings (a CAD account holding a USD
      ETF is summed in the holding&apos;s own currency, not the account&apos;s).
      Alderfi&apos;s multi-currency story isn&apos;t documented as of
      2026-05-13.
    </>,
    <>
      <strong className="text-foreground">
        You want the Anthropic Connectors Directory pipeline.
      </strong>{" "}
      Finlynq submitted on 2026-05-09 and is awaiting review. Alderfi is not in
      the directory or pipeline as of 2026-05-13.
    </>,
  ],
  comparisonRows: [
    {
      label: "License",
      finlynq: "AGPL v3 (network copyleft)",
      competitor: "Apache-2.0 (permissive, patent grant)",
    },
    {
      label: "Stage",
      finlynq: "Production; hosted finlynq.com + self-host",
      competitor:
        "Pre-alpha; first self-hostable alpha targets mid-May 2026",
    },
    {
      label: "Repo state (2026-05-13)",
      finlynq: "Active development on dev + main, weekly releases",
      competitor: "1 star, last push 2026-04-18, scaffold with 1 mock tool",
    },
    {
      label: "Hosted demo",
      finlynq: "Yes — demo@finlynq.com / finlynq-demo, resets nightly",
      competitor: "No (paid hosted tier planned)",
    },
    {
      label: "Self-host",
      finlynq: "Docker + PostgreSQL, feature parity with cloud",
      competitor: "Documented (SQLite local-first); alpha pending",
    },
    {
      label: "First-party MCP",
      finlynq: (
        <>
          Yes — <strong className="text-foreground">91 HTTP / 87 stdio</strong>{" "}
          tools
        </>
      ),
      competitor: "Yes — 1 mock tool today; roadmap implies more",
    },
    {
      label: "Local LLM support",
      finlynq: "No (cloud LLMs only — Claude, ChatGPT, Cursor, Windsurf)",
      competitor: "Yes — Llama 3 8B via llama.cpp",
    },
    {
      label: "MCP auth",
      finlynq: "OAuth 2.1 + DCR, Bearer API key, or stdio",
      competitor: "Not yet defined publicly",
    },
    {
      label: "Encryption at rest",
      finlynq:
        "Per-user envelope encryption (AES-256-GCM + scrypt-derived KEK + pepper); operator cannot decrypt user data",
      competitor: "Not publicly documented",
    },
    {
      label: "Bank sync / import",
      finlynq:
        "CSV / Excel / PDF / OFX / QFX / email-via-Resend; staging-review pipeline; connector framework",
      competitor: "CSV + SimpleFIN documented; Plaid planned for paid tier",
    },
    {
      label: "Multi-currency",
      finlynq:
        "32 fiats + 4 cryptos + 4 metals; per-currency cost-basis bucketing; FX with historical lookup + overrides",
      competitor: "Not documented",
    },
    {
      label: "Investments / portfolio",
      finlynq:
        "Cost basis, dividends, FX-aware aggregation, multi-account holdings",
      competitor: "Not documented",
    },
    {
      label: "Database",
      finlynq: "PostgreSQL (pg + Drizzle)",
      competitor: "SQLite (local-first)",
    },
    {
      label: "Language",
      finlynq: "TypeScript (Next.js 16 App Router)",
      competitor: "JavaScript / TypeScript",
    },
    {
      label: "Anthropic Connectors Directory",
      finlynq: "Submitted 2026-05-09, awaiting review",
      competitor: "Not submitted",
    },
    {
      label: "Pricing",
      finlynq:
        "Donation-based (GitHub Sponsors, Ko-fi); same features cloud + self-host",
      competitor: "Free OSS; paid hosted tier planned",
    },
  ],
  migrationSteps: [
    <>
      <strong className="text-foreground">From Alderfi to Finlynq.</strong>{" "}
      Alderfi&apos;s SQLite store can be dumped via standard SQL tooling. Map
      transactions to CSV (date, amount, currency, payee, category, account)
      and feed into Finlynq&apos;s staging-review at <code>/import/reconcile</code> —
      multi-currency, transfer-pair detection, and SHA-256 dedup over plaintext
      payee are all built in.
    </>,
    <>
      <strong className="text-foreground">From Finlynq to Alderfi.</strong>{" "}
      Finlynq&apos;s data-export endpoint produces a JSON backup with
      transactions, accounts, categories, portfolio holdings, and goals.
      You&apos;ll need to write a small JSON-to-Alderfi-import bridge once
      Alderfi&apos;s import surface stabilizes — neither side has a one-click
      migration today.
    </>,
    <>
      <strong className="text-foreground">Hooking up your AI client.</strong>{" "}
      For Finlynq: Claude → Customize → Connectors → {`"`}+{`"`} → paste{" "}
      <code>https://finlynq.com/mcp</code>. OAuth 2.1 handles the rest. For
      Alderfi: per the repo, use{" "}
      <code>npx @modelcontextprotocol/inspector npm run dev</code> against a
      local server. Both projects support any MCP-compatible client.
    </>,
  ],
  faq: [
    {
      q: "Isn't Alderfi just a 'future Finlynq' — why not wait for it?",
      a: (
        <>
          You might. The two projects make different trade-offs. Alderfi&apos;s
          commitments (Apache-2.0, local-LLM-first) are structural and unlikely
          to change. Finlynq&apos;s commitments (AGPL v3, hosted + self-host
          parity, current 91-tool surface) are also structural. If Apache-2.0
          and local-LLM matter more than shipped surface, waiting is
          reasonable. If you need something running today against real
          transactions, Finlynq is the project that has it.
        </>
      ),
    },
    {
      q: "Why AGPL v3 instead of Apache like Alderfi?",
      a: (
        <>
          We chose AGPL deliberately. Personal finance is a category that
          historically gets enclosed (Mint → Intuit → shutdown; Hiro → OpenAI →
          shutdown). AGPL §13&apos;s {`"`}network use{`"`} clause means anyone
          running Finlynq as a hosted service must publish their changes —
          which keeps the open-source core honest as the project gets adopted
          by others. Apache-2.0 doesn&apos;t do that. It&apos;s a legitimate
          trade-off; both choices have integrity. If you specifically want a
          permissive license so you can ship a derivative without sharing
          changes back, Apache (Alderfi) is the better fit.
        </>
      ),
    },
    {
      q: "Does Finlynq support local LLMs?",
      a: (
        <>
          Not today. Finlynq&apos;s MCP server speaks Streamable HTTP and
          stdio, and any MCP-compatible client can connect — including a local
          Ollama / llama.cpp / LM Studio runtime if it exposes MCP. But Finlynq
          doesn&apos;t ship a bundled local-LLM runtime the way Alderfi does,
          and the categorization / suggestion code paths assume an external MCP
          client. This is a real gap for users with a {`"`}no cloud LLM{`"`}{" "}
          threat model.
        </>
      ),
    },
    {
      q: "Doesn't Alderfi's 'the app is the MCP server' framing make Finlynq's architecture obsolete?",
      a: (
        <>
          It&apos;s a cleaner pitch, but they&apos;re two ways of describing
          similar architectures. Finlynq&apos;s MCP server is a first-class
          module of the app (<code>pf-app/mcp-server/</code>) — not a wrapper
          or a side-channel. The framing difference matters more for marketing
          than for architecture.
        </>
      ),
    },
    {
      q: "Alderfi is pre-alpha. Why give it a comparison page at all?",
      a: (
        <>
          Because the people most likely to compare AI-native open-source PFMs
          in 2026 are doing it before either project is mature. An honest,
          dated comparison that survives Alderfi shipping its alpha is more
          useful than a {`"`}we&apos;re better because they don&apos;t exist
          yet{`"`} page that gets embarrassing in three months. Re-check the
          numbers on this page against alderfi.org and the repo before quoting.
        </>
      ),
    },
  ],
  sources: [
    {
      label: "alderfi.org",
      href: "https://alderfi.org",
      note: "Alderfi project page; fetched 2026-05-13",
    },
    {
      label: "github.com/Earleybeast/mcp",
      href: "https://github.com/Earleybeast/mcp",
      note: "Alderfi repo; fetched 2026-05-13",
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

export default function VsAlderfiPage() {
  return <VsPage content={content} />;
}
