import type { Metadata } from "next";
import { VsPage, type VsPageContent } from "../_components/VsPage";

export const metadata: Metadata = {
  title: "Finlynq vs Ghostfolio: full PFM + first-party MCP vs portfolio tracker",
  description:
    "Finlynq vs Ghostfolio: both open-source AGPL v3 and self-hostable. Ghostfolio is a best-in-class investment tracker, but it's investments-only; Finlynq covers the full personal-finance surface (budgets, transactions, loans, goals) and ships a first-party MCP server with read and write tools. Side-by-side table, when to choose each, migration steps.",
  alternates: { canonical: "/vs/ghostfolio" },
  openGraph: {
    title: "Finlynq vs Ghostfolio: full PFM + first-party MCP vs portfolio tracker",
    description:
      "Both AGPL v3 and self-hostable. Ghostfolio: best-in-class portfolio analytics, investments-only. Finlynq: full PFM + first-party MCP with write access.",
    url: "/vs/ghostfolio",
    siteName: "Finlynq",
    type: "article",
  },
  twitter: {
    card: "summary_large_image",
    title: "Finlynq vs Ghostfolio",
    description:
      "Full personal-finance app with first-party MCP vs a dedicated open-source portfolio tracker.",
  },
};

const content: VsPageContent = {
  competitorName: "Ghostfolio",
  slug: "ghostfolio",
  tagline:
    "Ghostfolio is the leading open-source, AGPL v3 portfolio and wealth tracker, with best-in-class investment analytics, but it's investments-only. Finlynq is also AGPL v3 and self-hostable, and it covers the full personal-finance surface (budgets, transactions, loans, goals) plus a first-party MCP server with read and write tools.",
  whenCompetitor: [
    "You want a dedicated, polished investment tracker: time-weighted and money-weighted return, dividends, and allocation by asset, country, sector, and industry. Its portfolio analytics are the most mature in this set.",
    "You want a mature dual-host model today: free self-host plus a Ghostfolio Premium managed cloud (~$15/yr) with professionally sourced data feeds.",
    "You want a PWA plus an official Android wrapper right now. Finlynq also ships native iOS and Android apps.",
    "You want broad self-host distribution, with community templates for CasaOS, Home Assistant, Unraid, and Umbrel, plus a very high release cadence.",
    "You only track investments and don't need budgets, transactions, loans, or subscriptions.",
  ],
  whenFinlynq: [
    "You want the whole personal-finance picture in one app: budgets, transactions, loans and amortization, goals, subscriptions, not just a portfolio. Ghostfolio is portfolio-only.",
    "You want a first-party MCP server. Ghostfolio ships none; it proposed a read-only Claude Agent SDK chat (not MCP) that was unshipped at the time of writing. A small third-party community wrapper exists, but it's not official.",
    "You want AI write access, not just read. Ghostfolio's proposed assistant is read-only; Finlynq's MCP supports write tools with a confirmation-token preview/execute pattern.",
    "You want per-user envelope encryption of names. Ghostfolio stores account, symbol, and comment names without per-user encryption.",
    "You want any bank or transaction import at all. Finlynq supports direct bank connections that auto-sync transactions, plus file/email/CSV/OFX/QFX/PDF import; Ghostfolio has no bank aggregation, just manual entry or CSV/JSON activities import.",
    "You want trade-date-locked multi-currency cost basis. Ghostfolio re-converts at the current spot rate, a documented cost-basis-drift issue.",
  ],
  comparisonRows: [
    { label: "License", finlynq: "AGPL v3", competitor: "AGPL v3 (same as Finlynq)" },
    {
      label: "Hosting",
      finlynq: "Self-host (Docker + PostgreSQL) or managed cloud",
      competitor: "Both: self-host Docker and managed cloud at ghostfol.io",
    },
    {
      label: "First-party MCP",
      finlynq: "Yes, 109 HTTP / 93 stdio tools",
      competitor:
        "No: proposed read-only Claude Agent SDK chat (unshipped); a small third-party community MCP wrapper exists",
    },
    {
      label: "MCP auth",
      finlynq: "OAuth 2.1 + DCR, Bearer API key, or stdio",
      competitor: "N/A first-party; community wrapper uses a Ghostfolio API token",
    },
    {
      label: "REST / HTTP API",
      finlynq: "Yes, full surface mirrored from MCP",
      competitor: "Yes: public API; activities import/export",
    },
    {
      label: "Bank sync",
      finlynq:
        "Direct bank connections (auto-sync), plus file / CSV / OFX / QFX import and a connector framework.",
      competitor: "None: manual + CSV/JSON activities import only",
    },
    {
      label: "Encryption at rest",
      finlynq:
        "Per-user envelope encryption (AES-256-GCM, scrypt-derived KEK). Operator cannot decrypt names.",
      competitor: "No per-user / column encryption (names stored in plaintext)",
    },
    {
      label: "Multi-currency",
      finlynq: "Native, per-currency cost basis, FX locked at trade date",
      competitor: "Yes, but it converts at the current spot rate, so cost basis drifts (known issue)",
    },
    {
      label: "Investment / portfolio",
      finlynq:
        "Lot-tracked cost basis, dividends, FX-aware aggregation; RRSP/TFSA/RESP",
      competitor:
        "Best-in-class of this set: TWR/MWR, dividends, allocation/risk breakdowns, crypto-native",
    },
    {
      label: "Native mobile app",
      finlynq: "Yes, native iOS and Android apps (App Store, Google Play)",
      competitor: "PWA + official Android wrapper",
    },
    {
      label: "Multi-user / household",
      finlynq: "No (single-user)",
      competitor: "Yes: multiple independent users per instance",
    },
    {
      label: "Pricing",
      finlynq: "Donation-based; same features on self-host and managed cloud",
      competitor: "Self-host free; Ghostfolio Premium cloud ~$15/yr",
    },
    {
      label: "Funding / revenue model",
      finlynq: "Bootstrapped, donations",
      competitor: "Donations + low-priced Premium cloud covering hosting/data costs",
    },
  ],
  migrationSteps: [
    "Export from Ghostfolio. Use the activities JSON/CSV export of your buys, sells, and dividends.",
    "Import into Finlynq at /import/reconcile (or record trades via the portfolio flow). Review and edit, with FX-aware cost basis and per-holding currency handled in staging.",
    "Connect Claude (or any MCP client) at /mcp for natural-language portfolio queries that also reach your budgets, loans, and goals.",
  ],
  faq: [
    {
      q: "Isn't Ghostfolio's portfolio tracking better than Finlynq's?",
      a: "Its analytics (TWR/MWR, allocation breakdowns) are more polished, no argument there. Finlynq's edge is scope (budgets + portfolio + loans + goals in one app), trade-date-locked multi-currency cost basis, and a first-party MCP server.",
    },
    {
      q: "Does Ghostfolio have an MCP server?",
      a: "Not a first-party one. It proposed a Claude Agent SDK chat (read-only, unshipped at the time of writing). A small third-party community wrapper exists, but it isn't official or maintained by the Ghostfolio team.",
    },
    {
      q: "Can Ghostfolio sync my bank?",
      a: "No, it has no bank aggregation. It's manual entry or CSV/JSON activities import. Finlynq supports direct bank connections that auto-sync transactions (your credentials stay with a third-party aggregator, never Finlynq's servers), and manual CSV/OFX/QFX/PDF/email import is always available.",
    },
    {
      q: "Is Ghostfolio's multi-currency accurate?",
      a: "It converts using the current spot rate, which causes cost-basis drift (a documented open issue). Finlynq locks FX at trade date.",
    },
    {
      q: "They're both AGPL v3. Why pick Finlynq?",
      a: "If you only want investments, Ghostfolio is a strong, mature choice. Finlynq is for users who want investments plus budgets, loans, and goals, plus a first-party MCP server with write access and per-user encryption.",
    },
  ],
  sources: [
    {
      label: "ghostfolio/ghostfolio on GitHub",
      href: "https://github.com/ghostfolio/ghostfolio",
      note: "AGPL v3, fetched 2026-05-29",
    },
    {
      label: "Ghostfolio pricing",
      href: "https://ghostfol.io/en/pricing",
      note: "Premium ~$15/yr, fetched 2026-05-29",
    },
    {
      label: "mhajder/ghostfolio-mcp",
      href: "https://github.com/mhajder/ghostfolio-mcp",
      note: "third-party community MCP (not first-party), fetched 2026-05-29",
    },
    {
      label: "Finlynq on GitHub",
      href: "https://github.com/finlynq/finlynq",
      note: "AGPL v3 source",
    },
  ],
  lastUpdated: "2026-07-01",
};

export default function VsGhostfolioPage() {
  return <VsPage content={content} />;
}
