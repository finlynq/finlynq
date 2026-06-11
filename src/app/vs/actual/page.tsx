import type { Metadata } from "next";
import { VsPage, type VsPageContent } from "../_components/VsPage";

export const metadata: Metadata = {
  title: "Finlynq vs Actual Budget — open-source PFM with investments & MCP",
  description:
    "Finlynq vs Actual Budget: two open-source self-hostable personal finance apps. Actual is best-in-class local-first envelope budgeting; Finlynq adds native investment tracking, correct multi-currency, per-user envelope encryption, and a first-party MCP server. Side-by-side table, when to choose each, and migration steps.",
  alternates: { canonical: "/vs/actual" },
  openGraph: {
    title: "Finlynq vs Actual Budget — open-source PFM with investments & MCP",
    description:
      "Two open-source self-hostable PFMs. Actual: local-first envelope budgeting (MIT). Finlynq: investments + multi-currency + per-user encryption + a first-party MCP server.",
    url: "/vs/actual",
    siteName: "Finlynq",
    type: "article",
  },
  twitter: {
    card: "summary_large_image",
    title: "Finlynq vs Actual Budget",
    description:
      "Open-source PFMs compared. Actual's local-first budgeting vs Finlynq's investments, multi-currency, and first-party MCP.",
  },
};

const content: VsPageContent = {
  competitorName: "Actual Budget",
  slug: "actual",
  tagline:
    "Actual Budget is the leading open-source, local-first envelope-budgeting app — a popular YNAB replacement. Finlynq is also open-source and self-hostable, but adds native investment tracking, correct multi-currency, per-user envelope encryption, and a first-party MCP server that Actual's maintainers have declined to ship.",
  whenCompetitor: [
    "You want best-in-class envelope / zero-based budgeting UX — a keyboard-driven register, payee autocomplete, splits, and schedules. Actual nails budgeting in a way Finlynq does not aim to.",
    "You want true local-first with opt-in end-to-end encryption — your data lives on-device and the sync server stores opaque encrypted blobs. Architecturally very private for a single user's data.",
    "You want a permissive MIT license (proprietary forks allowed) rather than Finlynq's copyleft AGPL v3.",
    "You want built-in bank sync via GoCardless (EU/UK), SimpleFIN Bridge (US/Canada), or Pluggy.ai (Brazil). Finlynq has no first-party bank sync today.",
    "You want a desktop app and offline-first multi-device via Actual's sync engine.",
  ],
  whenFinlynq: [
    "You want native investment / portfolio tracking — holdings, lot-tracked cost basis, dividends. Actual has none; it is a budgeting app, full stop. This is the single largest feature gap.",
    "You want first-party multi-currency. Actual's docs state it is currency-agnostic and does not support multi-currency; the workaround is separate budgets. Finlynq locks FX at trade date.",
    "You want a first-party MCP server. Actual has shipped none and closed AI feature requests without merging. A capable community server exists (s-stefanov/actual-mcp) but is not blessed or in-app.",
    "You want an official managed cloud from the project. Actual offers none — you self-host or trust a third-party host. Finlynq offers finlynq.com/cloud directly.",
    "You want per-user encryption that is on by default. Actual's E2EE is opt-in; default installs store plaintext on the sync server.",
    "You want loans / amortization, goals, and subscription detection in the same app. Actual is budgeting-only.",
  ],
  comparisonRows: [
    { label: "License", finlynq: "AGPL v3", competitor: "MIT (more permissive)" },
    {
      label: "Hosting",
      finlynq: "Self-host (Docker + PostgreSQL) or managed cloud",
      competitor: "Self-host Docker or local-first; no official managed cloud",
    },
    {
      label: "First-party MCP",
      finlynq: "Yes — 102 HTTP / 93 stdio tools",
      competitor:
        "No — AI requests closed unmerged; community s-stefanov/actual-mcp exists",
    },
    {
      label: "MCP auth",
      finlynq: "OAuth 2.1 + DCR, Bearer API key, or stdio",
      competitor: "Community MCP supports optional bearer auth against the server",
    },
    {
      label: "REST / HTTP API",
      finlynq: "Yes — full surface mirrored from MCP",
      competitor: "Programmatic access via the @actual-app/api Node library",
    },
    {
      label: "Bank sync",
      finlynq:
        "File / email import + connector framework. No first-party Plaid today.",
      competitor:
        "GoCardless (EU/UK, no new accounts since 2025) + SimpleFIN (US/Canada) + Pluggy.ai (Brazil); CSV/QIF/OFX import",
    },
    {
      label: "Encryption at rest",
      finlynq:
        "Per-user envelope encryption (AES-256-GCM, scrypt-derived KEK), on by default",
      competitor: "Opt-in end-to-end; default is plaintext on the sync server",
    },
    {
      label: "Multi-currency",
      finlynq: "Native, per-currency cost basis, FX locked at trade date",
      competitor: "No — currency-agnostic; single-currency budget per docs",
    },
    {
      label: "Investment / portfolio",
      finlynq:
        "Lot-tracked cost basis, dividends, FX-aware aggregation; RRSP/TFSA/RESP",
      competitor: "None",
    },
    {
      label: "Native mobile app",
      finlynq: "React Native (Expo) app — functional, not at parity with consumer apps",
      competitor: "No native app; mobile-responsive web / PWA + desktop",
    },
    {
      label: "Multi-user / household",
      finlynq: "No (single-user)",
      competitor: "Multi-user shipped (requires an OpenID provider for login)",
    },
    {
      label: "Pricing",
      finlynq: "Donation-based; same features on self-host and managed cloud",
      competitor: "Free / donation-based; third-party managed hosts ~$1-5/mo",
    },
    {
      label: "Funding / revenue model",
      finlynq: "Bootstrapped, donations",
      competitor: "Community-governed (actualbudget org); donations",
    },
  ],
  migrationSteps: [
    "Export from Actual — use the file export, or pull data via the @actual-app/api Node library.",
    "Import into Finlynq at /import/reconcile — review and edit each row; transfer pairs, multi-currency, and dedup are handled in staging.",
    "Connect Claude (or any MCP client) at /mcp — paste the URL into Claude → Customize → Connectors; OAuth handles auth.",
  ],
  faq: [
    {
      q: "Is Actual's budgeting better than Finlynq's?",
      a: "For pure envelope / zero-based budgeting UX, generally yes — Actual's register and shortcuts are excellent. Finlynq covers a wider surface (investments, loans, goals, multi-currency) and adds MCP.",
    },
    {
      q: "Actual is local-first and end-to-end encrypted — isn't that more private?",
      a: "For a single device, Actual's opt-in E2EE is architecturally strong. But it is opt-in (the default stores plaintext on the sync server), whereas Finlynq's per-user envelope encryption is always on server-side, which is also what makes the MCP story work.",
    },
    {
      q: "Does Actual have a first-party MCP or AI feature?",
      a: "No. AI requests were closed unmerged and the roadmap is silent on AI. A capable community MCP exists (s-stefanov/actual-mcp), but it is third-party and not integrated into the app.",
    },
    {
      q: "Does Actual track investments?",
      a: "No — it is budgeting only. If you want budgets and a portfolio in one app, that is a Finlynq advantage.",
    },
    {
      q: "Can Actual do multi-currency?",
      a: "Not natively; its docs say it is currency-agnostic. Finlynq handles per-account and per-holding currency with FX locked at trade date.",
    },
  ],
  sources: [
    {
      label: "actualbudget/actual on GitHub",
      href: "https://github.com/actualbudget/actual",
      note: "MIT, fetched 2026-05-29",
    },
    {
      label: "Actual bank-sync docs (GoCardless + SimpleFIN)",
      href: "https://actualbudget.org/docs/advanced/bank-sync/",
      note: "fetched 2026-05-29",
    },
    {
      label: "s-stefanov/actual-mcp",
      href: "https://github.com/s-stefanov/actual-mcp",
      note: "community (not official) MCP",
    },
    {
      label: "Finlynq on GitHub",
      href: "https://github.com/finlynq/finlynq",
      note: "AGPL v3 source",
    },
  ],
  lastUpdated: "2026-05-29",
};

export default function VsActualPage() {
  return <VsPage content={content} />;
}
