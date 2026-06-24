import type { Metadata } from "next";
import { VsPage, type VsPageContent } from "../_components/VsPage";

export const metadata: Metadata = {
  title: "Finlynq vs Maybe (and the Sure fork): actively-built open-source PFM",
  description:
    "Finlynq vs Maybe Finance and its community fork Sure: Maybe was a venture-funded PFM that open-sourced after shutting down; Sure is the volunteer fork. Finlynq targets the same holistic user with a modern stack, per-user envelope encryption, and a first-party MCP server neither ships. Side-by-side table, when to choose each, migration steps.",
  alternates: { canonical: "/vs/maybe" },
  openGraph: {
    title: "Finlynq vs Maybe (and the Sure fork)",
    description:
      "Maybe open-sourced after shutting down; Sure is the volunteer fork. Finlynq: modern stack, per-user encryption, first-party MCP.",
    url: "/vs/maybe",
    siteName: "Finlynq",
    type: "article",
  },
  twitter: {
    card: "summary_large_image",
    title: "Finlynq vs Maybe / Sure",
    description:
      "Actively-developed, encrypted, MCP-first Finlynq compared with Maybe Finance and the Sure community fork.",
  },
};

const content: VsPageContent = {
  competitorName: "Maybe / Sure",
  slug: "maybe",
  tagline:
    "Maybe Finance was a venture-funded full personal-finance app that open-sourced after shutting down; Sure is the volunteer-run community fork that keeps it alive. Finlynq targets the same holistic user, but with a modern stack, per-user envelope encryption, and a first-party MCP server that neither Maybe nor Sure ships.",
  whenCompetitor: [
    "You want the inherited brand recognition and net-worth-first dashboard from the well-known open-sourced-after-shutdown project.",
    "You want Plaid bank aggregation already in the codebase. Maybe was Plaid-native (plus SimpleFIN), though Plaid is dormant after archival, so live sync means setting it up yourself.",
    "You prefer a conventional Ruby on Rails + Hotwire monolith that senior Ruby contributors can drop right into.",
    "You want full PFM scope (budgets, transactions, holdings, multi-currency) in one open-source app and don't need first-party AI or MCP.",
    "You specifically want the actively-maintained Sure fork's community momentum.",
  ],
  whenFinlynq: [
    "You want a single-team-led project with a clear roadmap. The original Maybe is archived, and Sure is volunteer-run with thinner roadmap clarity.",
    "You want a first-party MCP server. Neither Maybe nor Sure ships one. Maybe's old in-app AI was in-process OpenAI function-calling (not MCP, and not exposed to external clients). Finlynq ships first-party MCP (HTTP + stdio) with read and write tools.",
    "You want per-user envelope encryption where the operator can't read your data. Maybe and Sure have no app-layer column encryption.",
    "You want a modern React / TypeScript stack the AI-tooling ecosystem speaks natively, rather than a Rails / Hotwire monolith.",
    "You want an official managed cloud. Sure is self-host only; Finlynq offers finlynq.com/cloud.",
    "You want to steer clear of Plaid dependency risk, the same aggregator cost that helped sink the original Maybe company. Finlynq's import and connector framework is Plaid-independent.",
  ],
  comparisonRows: [
    { label: "License", finlynq: "AGPL v3", competitor: "AGPL v3 (same as Finlynq)" },
    {
      label: "Hosting",
      finlynq: "Self-host (Docker + PostgreSQL) or managed cloud",
      competitor: "Self-host via Docker (Sure fork); original Maybe cloud is gone",
    },
    {
      label: "First-party MCP",
      finlynq: "Yes, 109 HTTP / 93 stdio tools",
      competitor:
        "No: Maybe's in-app AI was in-process OpenAI function-calling; no documented Sure MCP",
    },
    {
      label: "MCP auth",
      finlynq: "OAuth 2.1 + DCR, Bearer API key, or stdio",
      competitor: "N/A (no MCP)",
    },
    {
      label: "REST / HTTP API",
      finlynq: "Yes, full surface mirrored from MCP",
      competitor: "Partial / internal; no mature documented public REST surface",
    },
    {
      label: "Bank sync",
      finlynq:
        "File / email import + connector framework. No first-party Plaid today.",
      competitor: "Plaid + SimpleFIN in code; Plaid dormant post-archival (self-config required)",
    },
    {
      label: "Encryption at rest",
      finlynq:
        "Per-user envelope encryption (AES-256-GCM, scrypt-derived KEK). Operator cannot decrypt.",
      competitor: "None at the app / column level",
    },
    {
      label: "Multi-currency",
      finlynq: "Native, per-currency cost basis, FX locked at trade date",
      competitor: "Yes (native), via a flat exchange-rate table",
    },
    {
      label: "Investment / portfolio",
      finlynq:
        "Lot-tracked cost basis, dividends, FX-aware aggregation; RRSP/TFSA/RESP",
      competitor: "Yes: securities, holdings, crypto, performance (a Maybe strength)",
    },
    {
      label: "Native mobile app",
      finlynq: "Yes, native iOS and Android apps (App Store, Google Play)",
      competitor: "No (Flutter companion code existed but never fully shipped)",
    },
    {
      label: "Multi-user / household",
      finlynq: "No (single-user)",
      competitor: "Yes (per-instance)",
    },
    {
      label: "Pricing",
      finlynq: "Donation-based; same features on self-host and managed cloud",
      competitor: "Free (self-host); original paid tier is defunct",
    },
    {
      label: "Funding / revenue model",
      finlynq: "Bootstrapped, donations",
      competitor:
        "Original raised ~$1.45M, shut down 2023, open-sourced, then archived July 2025 on a B2B pivot; Sure is volunteer / donation",
    },
  ],
  migrationSteps: [
    "Export from Maybe or Sure. Use the CSV export of transactions and holdings, or your database export if you're self-hosting.",
    "Import into Finlynq at /import/reconcile. Review and edit each row; multi-currency, transfer pairs, and dedup are handled in staging, and you record holdings via the portfolio flow.",
    "Connect Claude (or any MCP client) at /mcp. Paste the URL into Claude, then Customize, then Connectors; OAuth handles auth.",
  ],
  faq: [
    {
      q: "Is Maybe still being developed?",
      a: "The original maybe-finance/maybe repository was archived in 2025. The community fork Sure (we-promise/sure) is the de facto continuation and is still active, but it is volunteer-run with a less defined roadmap.",
    },
    {
      q: "Does Maybe/Sure have an MCP server?",
      a: "No. The original Maybe had an in-app AI chat using OpenAI function-calling internally, but that's not MCP and it wasn't exposed to external AI clients. No documented Sure MCP exists. Finlynq ships first-party MCP.",
    },
    {
      q: "Maybe has Plaid bank sync. Does Finlynq?",
      a: "Maybe was Plaid-native, but Plaid is dormant after archival and needs self-configuration. Finlynq has no first-party Plaid and uses import plus a connector framework instead (SnapTrade on the roadmap).",
    },
    {
      q: "Both are AGPL v3 and full PFMs. What's the real difference?",
      a: "Project health (single-team-led with a roadmap vs a volunteer fork), stack (React/TypeScript vs Rails/Hotwire), per-user envelope encryption, and a first-party MCP server with write access. None of which Maybe or Sure offers.",
    },
    {
      q: "Why did Maybe shut down?",
      a: "Per its founders, a combination of bad timing, a long build before validating fit, few paying customers at launch, and painful, expensive Plaid aggregation. Finlynq's donation-funded, Plaid-independent model is a deliberate response to that.",
    },
  ],
  sources: [
    {
      label: "maybe-finance/maybe (archived)",
      href: "https://github.com/maybe-finance/maybe",
      note: "archived 2025, AGPL v3",
    },
    {
      label: "we-promise/sure (community fork)",
      href: "https://github.com/we-promise/sure",
      note: "active community fork, fetched 2026-05-29",
    },
    {
      label: "Failory: why Maybe failed",
      href: "https://newsletter.failory.com/p/3-reasons-maybe-failed",
      note: "post-mortem: funding, Plaid cost",
    },
    {
      label: "Finlynq on GitHub",
      href: "https://github.com/finlynq/finlynq",
      note: "AGPL v3 source",
    },
  ],
  lastUpdated: "2026-05-29",
};

export default function VsMaybePage() {
  return <VsPage content={content} />;
}
