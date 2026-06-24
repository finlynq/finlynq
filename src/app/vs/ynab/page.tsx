import type { Metadata } from "next";
import { VsPage, type VsPageContent } from "../_components/VsPage";

export const metadata: Metadata = {
  title: "Finlynq vs YNAB: open-source alternative with investments & MCP",
  description:
    "Finlynq vs YNAB (You Need A Budget): open-source AGPL v3 with self-host, native investment tracking, multi-currency, per-user envelope encryption, and a first-party MCP server, set against YNAB's closed-source zero-based budgeting SaaS. Side-by-side table, when to choose each, and migration steps.",
  alternates: { canonical: "/vs/ynab" },
  openGraph: {
    title: "Finlynq vs YNAB: open-source alternative with investments & MCP",
    description:
      "Open-source self-hostable PFM with investments, multi-currency, encryption, and a first-party MCP server, compared with YNAB's zero-based budgeting SaaS.",
    url: "/vs/ynab",
    siteName: "Finlynq",
    type: "article",
  },
  twitter: {
    card: "summary_large_image",
    title: "Finlynq vs YNAB",
    description:
      "Open-source, self-hostable, investments + multi-currency + first-party MCP, compared with YNAB.",
  },
};

const content: VsPageContent = {
  competitorName: "YNAB",
  slug: "ynab",
  tagline:
    "YNAB (You Need A Budget) is the gold-standard closed-source budgeting SaaS, built on a strict zero-based, give-every-dollar-a-job method. Finlynq is the open-source, self-hostable alternative for people who also want investment tracking, multi-currency, encryption that the operator can't read, and a first-party MCP server, all with no subscription.",
  whenCompetitor: [
    "You want a proven, opinionated budgeting method with 20 years of content, books, and a strong community behind it. YNAB owns zero-based and envelope budgeting as a category; Finlynq doesn't push any one method.",
    "You want first-party bank sync that just works out of the box: Plaid (US/Canada, and now UK/EU Direct Import). Finlynq has no first-party bank sync today, just file and email import.",
    "You want a polished native iOS / Android app with best-in-class quick-entry at the register. YNAB's mobile apps are more mature than Finlynq's newer ones.",
    "You want shared household budgeting baked right in, with multiple people on one subscription. Finlynq is single-user.",
    "You want a long-stable, well-documented public REST API that a whole community of tools already builds on.",
  ],
  whenFinlynq: [
    "You want the source code (AGPL v3, on GitHub) and the option to self-host. YNAB is closed-source, SaaS-only, with no self-host path at all.",
    "You want to stop paying a subscription. YNAB runs roughly $14.99/mo or $109/yr; Finlynq is donation-funded, with the same features on self-host and managed cloud.",
    "You want native investment and portfolio tracking: holdings, lot-tracked cost basis, dividends, performance. YNAB tracks investment account balances for net worth only, by design.",
    "You want multi-currency in one place. YNAB is single-currency per budget, so international and expat users end up running separate budgets and tracking FX on the side.",
    "You want per-user encryption where even the operator can't read your payees, notes, or names. YNAB is a hosted SaaS that holds your data in a form it can read.",
    "You want a first-party MCP server. YNAB has shipped no official AI or MCP; community MCPs only exist because YNAB has a public API, and they proxy an all-or-nothing personal access token.",
  ],
  comparisonRows: [
    { label: "License", finlynq: "AGPL v3", competitor: "Closed source" },
    {
      label: "Hosting",
      finlynq: "Self-host (Docker + PostgreSQL) or managed cloud",
      competitor: "Hosted SaaS only (no self-host)",
    },
    {
      label: "First-party MCP",
      finlynq: "Yes, 109 HTTP / 93 stdio tools",
      competitor:
        "No, but a public REST API has spawned community MCPs (calebl/ynab-mcp-server and others)",
    },
    {
      label: "MCP auth",
      finlynq: "OAuth 2.1 + DCR, Bearer API key, or stdio",
      competitor: "Community MCPs proxy a YNAB personal access token (no scoping)",
    },
    {
      label: "REST / HTTP API",
      finlynq: "Yes, full surface mirrored from MCP",
      competitor: "Yes: official, documented, personal access token + OAuth 2.0",
    },
    {
      label: "Bank sync",
      finlynq:
        "File / email import + connector framework. No first-party Plaid today.",
      competitor: "Plaid (US/Canada, and UK/EU Direct Import); CSV/OFX/QFX elsewhere",
    },
    {
      label: "Encryption at rest",
      finlynq:
        "Per-user envelope encryption (AES-256-GCM, scrypt-derived KEK). Operator cannot decrypt.",
      competitor: "Operator-held (hosted SaaS); no per-user / zero-knowledge model",
    },
    {
      label: "Multi-currency",
      finlynq: "Native, per-currency cost basis, FX locked at trade date",
      competitor: "No: one budget is one currency",
    },
    {
      label: "Investment / portfolio",
      finlynq:
        "Lot-tracked cost basis, dividends, FX-aware aggregation; RRSP/TFSA/RESP",
      competitor: "Balance-only for net worth; no holdings/cost-basis/dividends",
    },
    {
      label: "Native mobile app",
      finlynq: "Yes, native iOS and Android apps (App Store, Google Play); newer and still maturing",
      competitor: "Yes: iOS, Android, Apple Watch (best-in-class quick-entry)",
    },
    {
      label: "Multi-user / household",
      finlynq: "No (single-user)",
      competitor: "Yes: multiple people on one subscription",
    },
    {
      label: "Pricing",
      finlynq: "Donation-based; same features on self-host and managed cloud",
      competitor: "~$14.99/mo or ~$109/yr; 34-day trial; free year for students",
    },
    {
      label: "Funding / revenue model",
      finlynq: "Bootstrapped, donations",
      competitor: "Bootstrapped (no outside VC), founder-led; subscription revenue",
    },
  ],
  migrationSteps: [
    "Export your YNAB data. Use the CSV export from the web app, or pull transactions via the YNAB REST API with a personal access token.",
    "Import into Finlynq via the staging-review pipeline at /import/reconcile. Review and edit each row; multi-currency, transfer-pair detection, and dedup are all built in.",
    "Connect your AI client: Claude, then Customize, then Connectors, then paste https://finlynq.com/mcp (or your self-host /mcp URL). OAuth handles the rest.",
  ],
  faq: [
    {
      q: "Does Finlynq enforce zero-based budgeting like YNAB?",
      a: "No. Finlynq supports category budgets, but it isn't built around one opinionated method. If the give-every-dollar-a-job discipline is the whole reason you'd use YNAB, YNAB does that better.",
    },
    {
      q: "Can Finlynq sync my bank like YNAB does?",
      a: "Not with first-party bank sync today. Finlynq imports via CSV/OFX/QFX/PDF/email and a connector framework; SnapTrade is on the roadmap. YNAB's Plaid-based sync is more automatic.",
    },
    {
      q: "Why compare a free app to a paid one?",
      a: "The comparison isn't really about price. It's about source availability, self-hosting, who can read your data, and whether you get investments, multi-currency, and MCP at all. Finlynq's argument is structural.",
    },
    {
      q: "Does Finlynq track investments? YNAB does not.",
      a: "Yes: holdings, lot-tracked cost basis, dividends, and FX-aware aggregation across accounts, including Canadian RRSP/TFSA/RESP accounts. This is one of the clearest gaps in YNAB.",
    },
    {
      q: "Can my household share a Finlynq budget like YNAB's family plan?",
      a: "Not yet. Finlynq is single-user today. YNAB's shared-budget pricing is genuinely strong for households.",
    },
  ],
  sources: [
    {
      label: "YNAB pricing",
      href: "https://www.ynab.com/pricing",
      note: "fetched 2026-05-29",
    },
    {
      label: "YNAB API documentation",
      href: "https://api.ynab.com/",
      note: "official PAT + OAuth 2.0 surface, fetched 2026-05-29",
    },
    {
      label: "calebl/ynab-mcp-server",
      href: "https://github.com/calebl/ynab-mcp-server",
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

export default function VsYnabPage() {
  return <VsPage content={content} />;
}
