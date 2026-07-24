/**
 * Release-notes content for `/releases` + `/releases/<slug>`.
 *
 * Hand-authored, crawlable release announcements. Each entry targets
 * version-intent and "what's new in Finlynq" queries and feeds AI-assistant
 * citation. Rendered without any markdown dependency (sections are plain
 * structured data) so there is zero lockfile risk, mirroring the glossary
 * module.
 *
 * Add an entry here and it flows into the sitemap, the /releases index, and
 * llms-full.txt automatically. Slugs match the GitHub release tag
 * (`/releases/tag/<slug>`), e.g. "v3.3.0".
 */

/** A grouped block of highlights ("Investing", "Security", ...). */
export type ReleaseSection = { heading: string; items: string[] };

export type Release = {
  /** Semantic version without the "v" prefix, e.g. "3.3.0". */
  version: string;
  /** URL slug + GitHub tag, e.g. "v3.3.0". */
  slug: string;
  /** Page H1 + document title. */
  name: string;
  /** ISO release date. */
  date: string;
  /** True for the newest release (drives the "Latest" badge). */
  current: boolean;
  /** Meta description AND the index-card blurb (snippet-friendly). */
  tagline: string;
  /** Lead paragraph(s) after the H1. */
  summary: string[];
  /** Grouped highlights. */
  sections: ReleaseSection[];
  /** Canonical GitHub release URL. */
  githubUrl: string;
};

export const RELEASES: Release[] = [
  {
    version: "3.4.0",
    slug: "v3.4.0",
    name: "Finlynq v3.4.0",
    date: "2026-07-24",
    current: true,
    tagline:
      "Finlynq v3.4.0 rebuilds the MCP surface around 54 focused tools, makes statement reconciliation something you can do entirely in chat, and fixes self-hosting so the documented Docker Quick Start works end to end.",
    summary: [
      "Finlynq v3.4.0 is the biggest update to the AI side of the app so far. The MCP server went from 117 tools to 54, reconciliation became something you can run start to finish in a conversation, and every number the assistant reports now states how it was valued.",
      "Self-hosters get the headline fix: the published Docker image can now build its own database schema, so the Quick Start in the README actually works. Every published tag from 3.2.0 through 3.3.2 was unusable.",
      "Finlynq is an open-source (AGPL v3) personal finance app with a first-party Model Context Protocol (MCP) server, so you can track your money in the app and analyze it from Claude, Cursor, Windsurf, or any MCP-compatible assistant.",
    ],
    sections: [
      {
        heading: "Self-hosting",
        items: [
          "The published Docker image now builds its own database schema on first boot, so the documented Quick Start works end to end. Previously the container crash-looped or came up with roughly half the tables missing, which made every published tag from 3.2.0 to 3.3.2 unusable for new self-hosters. Reported by jcdev7858.",
          "CI now builds the image, runs the documented Quick Start verbatim, and registers a real user before anything is published. A health check alone passed against a half-built schema, which is exactly how this shipped in the first place.",
        ],
      },
      {
        heading: "AI assistants",
        items: [
          "The tool surface is consolidated from 117 tools to 54. Related operations are grouped into single tools that take an operation name, so assistants choose correctly more often and spend far fewer tokens reading the tool list.",
          "Reconciliation now works entirely in chat: hand your assistant a statement, and it can stage it, match rows against your ledger, commit in batches, and set a balance anchor. It works on the hosted connector with no configuration, where it previously required a setting most people never found.",
          "Every money figure now states the basis it was valued on, so market value, ledger value, and cost basis can no longer be mistaken for one another.",
          "When a name matches two or more of your records, tools now return the candidates and ask, instead of silently picking the first one. Passing an explicit id always wins over a name.",
          "Categories can be renamed and merged from your assistant.",
          "Note for existing integrations: tool names retired in the v4 consolidation now return a clear error instead of working silently. If you have scripts calling the old per-verb names, point them at the grouped tools.",
        ],
      },
      {
        heading: "Investing",
        items: [
          "Cross-currency cash transfers no longer stop a full lot rebuild partway through.",
          "Realized-gain responses state which FX conversion method produced them.",
        ],
      },
      {
        heading: "Fixes",
        items: [
          "The cash-flow forecast now scopes to your actual cash accounts rather than matching account group names literally, so default Checking and Savings accounts are no longer excluded. Recurring items from out-of-scope accounts no longer project against an unrelated balance.",
          "A biweekly paycheck that alternates between two amounts is now detected as recurring instead of being dropped as inconsistent.",
          "Bulk transaction creation returns each new transaction id, so an assistant can act on what it just created without searching for it again.",
        ],
      },
      {
        heading: "Licensing",
        items: [
          "LICENSE is now the complete, unmodified AGPL-3.0 text, so automated tooling can identify it correctly. The commercial position moved to COMMERCIAL.md and is now an offer rather than a restriction: the AGPL applies to everyone on identical terms, and a commercial license is available to companies that need an exemption from its copyleft.",
        ],
      },
    ],
    githubUrl: "https://github.com/finlynq/finlynq/releases/tag/v3.4.0",
  },
  {
    version: "3.3.2",
    slug: "v3.3.2",
    name: "Finlynq v3.3.2",
    date: "2026-07-01",
    current: false,
    tagline:
      "Finlynq v3.3.2 brings native iOS and Android apps, direct bank connections, a unified import pipeline, and more control over investing accuracy.",
    summary: [
      "Finlynq v3.3.2 is an interim update since v3.3.1. The headline: native mobile apps are here, and you can now connect your bank so transactions sync in automatically.",
      "Finlynq is an open-source (AGPL v3) personal finance app with a first-party Model Context Protocol (MCP) server, so you can track your money in the app and analyze it from Claude, Cursor, Windsurf, or any MCP-compatible assistant.",
    ],
    sections: [
      {
        heading: "Mobile",
        items: [
          "Native iOS and Android apps, free on the App Store and Google Play. They cover Dashboard, Transactions, Import, Budgets, and Settings, and sign in to the same encrypted account as the web app, on the managed cloud or your own self-hosted instance.",
        ],
      },
      {
        heading: "Bank connections and import",
        items: [
          "Connect your bank directly and transactions flow in automatically, with a review step before anything lands. Your bank login stays with a third-party aggregator and never touches Finlynq's servers.",
          "One unified import pipeline: bank feeds and uploaded statements flow through the same staged review, and a per-account mode (manual, approve, or auto) decides how far each import advances on its own.",
          "Auto-skip duplicates you already have, so re-syncing or re-importing never doubles up your ledger.",
        ],
      },
      {
        heading: "Investing",
        items: [
          "Manual and custom pricing for your own securities, so holdings your providers can't price still value correctly.",
          "A whole-ticker lot allocation editor: assign each sale to specific lots in one matrix, with FIFO, HIFO, and LIFO quick strategies.",
          "Per-ticker lot rebuild plus an out-of-order-import warning, to fix positions where a sell was imported before its buy.",
          "The All Holdings page now reads the lot engine, so cost basis and realized gains match the rest of your reports.",
        ],
      },
      {
        heading: "Portfolio views",
        items: [
          "All Holdings gains sortable columns, split Day and Unrealized gain columns, Price, Total Cost, and Day G/L columns, a holding-currency toggle, and Day G/L for metals and foreign-currency cash.",
        ],
      },
      {
        heading: "Accounts",
        items: [
          "Set an account opening balance, backed by a single linked transaction so your history stays correct.",
          "An investment-account toggle on the create and edit dialogs.",
        ],
      },
      {
        heading: "Fixes",
        items: [
          "Realized-gain conversion is now correct in a non-USD display currency, including short positions in the Show in CAD view.",
          "Editing a dividend received as shares (DRIP) no longer converts it to cash.",
          "More reliable crypto prices, plus fixes to the transactions ticker filter and holding drill-through.",
          "Paste a screenshot straight into the feedback box to attach it.",
        ],
      },
    ],
    githubUrl: "https://github.com/finlynq/finlynq/releases/tag/v3.3.2",
  },
  {
    version: "3.3.1",
    slug: "v3.3.1",
    name: "Finlynq v3.3.1",
    date: "2026-06-26",
    current: false,
    tagline:
      "Finlynq v3.3.1 adds Money Pro and Generic CSV importers, transaction quick-actions on account pages, a UI font picker, file attachments on feedback, and new MCP reconciliation tools (now 117 tools).",
    summary: [
      "Finlynq v3.3.1 is an interim update since v3.3.0, focused on getting your data in from other apps, faster everyday actions, and more for AI assistants.",
      "Finlynq is an open-source (AGPL v3) personal finance app with a first-party Model Context Protocol (MCP) server, so you can track your money in the app and analyze it from Claude, Cursor, Windsurf, or any MCP-compatible assistant.",
    ],
    sections: [
      {
        heading: "Import",
        items: [
          "A Money Pro (iBear) CSV importer for moving your history out of Money Pro.",
          "A Generic CSV (full-ledger) importer that takes any multi-account export, including transfers, with a column-matching step so it adapts to your file.",
          "Deep-linkable Settings to Import for jumping straight to a connector.",
        ],
      },
      {
        heading: "Accounts",
        items: [
          "Transaction quick-actions on the account page: add a transaction or investment transaction with the account pre-filled.",
          "Account configuration consolidated into a tabbed Edit dialog (Details, Reconciliation, Import, Cash sleeves).",
        ],
      },
      {
        heading: "Personalization and feedback",
        items: [
          "A user-selectable UI font with five options; numbers stay in a monospaced font for easy scanning.",
          "Attach a screenshot or file to feedback and replies.",
        ],
      },
      {
        heading: "AI and the MCP server",
        items: [
          "The MCP server now ships 117 HTTP tools, up from 109.",
          "New reconciliation tools: upload a statement via MCP, a portfolio-wide reconciliation summary, duplicate bank-row detection and removal, bulk accept matches, read and write balance anchors, and a bank-only staged promote.",
          "Reconciliation accuracy fixes for transfer legs and cascade deletes.",
        ],
      },
    ],
    githubUrl: "https://github.com/finlynq/finlynq/releases/tag/v3.3.1",
  },
  {
    version: "3.3.0",
    slug: "v3.3.0",
    name: "Finlynq v3.3.0",
    date: "2026-06-24",
    current: false,
    tagline:
      "Finlynq v3.3.0 adds a full lot-tracked investing engine, an MCP server that reconciles your bank ledger, import-by-email, multi-currency historical reporting, and an OAuth security pass. 248 improvements since v3.2.0.",
    summary: [
      "Finlynq v3.3.0 is our biggest update yet, with 248 features and fixes since v3.2.0. The headline is a complete lot-tracked investing engine, an MCP server that can now reconcile your bank ledger, the ability to import statements by email, and a round of security and OAuth hardening.",
      "Finlynq is an open-source (AGPL v3) personal finance app with a first-party Model Context Protocol (MCP) server, so you can track your money in the app and analyze it from Claude, Cursor, Windsurf, or any MCP-compatible assistant.",
    ],
    sections: [
      {
        heading: "Investing and portfolio",
        items: [
          "A full lot-tracked cost-basis engine with FIFO lots, short positions, per-lot reallocation, and a read-only lot inspector. Editing or deleting a buy now re-plans the dependent sells instead of blocking you.",
          "Performance reporting with time-weighted and money-weighted returns (TWRR and MWRR), daily snapshots, and a chart with by-holding and by-account stacked views.",
          "Realized-gains and dividend reports, with hide-zero and group-by options.",
          "A securities master that gives each ticker one identity across all your accounts, so a holding owned in three accounts rolls up to a single row, plus a one-click ticker change for renamed symbols.",
          "One-step DRIP: record dividends or income received as shares without the old income-then-buy workaround.",
          "Net Worth Over Time and Balance Over Time charts with historical-FX valuation and crypto pricing back to 2014.",
        ],
      },
      {
        heading: "AI and the MCP server (v3.3)",
        items: [
          "The MCP server now ships 109 HTTP tools and 93 stdio tools.",
          "Canonical portfolio write tools (buy, sell, swap, transfer, deposit, withdrawal, income and expense, FX conversion) run through the same lot-aware engine as the web app.",
          "New bank-ledger reconciliation and rule-application tools: get suggestions, materialize a bank row, accept or unlink a match, set account mode, and run Auto-pilot rules.",
          "Investment accounts are valued at market in the balance tools.",
          "Bookkeeping-only by design: Finlynq writes only to your own database and never connects to a bank or moves real money.",
        ],
      },
      {
        heading: "Import and reconciliation",
        items: [
          "One unified money-in screen with a two-ledger bank model, bank balance anchors, a reconciliation summary panel, and the ability to hide accounts from the dropdown.",
          "Auto-pilot, Approve-each, and Manual lenses per account.",
          "Investment imports can map ticker, security name, and quantity columns, and investment reconciliation rules can turn a matched bank row into a real lot-aware portfolio op.",
          "An OFX and QFX confirm dialog, per-template sign flip, CSV mapping confirmation, and out-of-range amount rejection at preview.",
        ],
      },
      {
        heading: "Import by email",
        items: [
          "Forward statements to a personal import address and Finlynq stages them automatically.",
          "Email rules with multi-condition matching (payee, body, amount) and a configurable retention window for raw emails.",
        ],
      },
      {
        heading: "Multi-currency",
        items: [
          "Reporting amounts are stored at the historical date rate per transaction, and flow reports sum the stored amounts.",
          "One display currency as the single source of truth, dollar-family symbols (C$, A$, and friends), and a USD default.",
          "Crypto is priced in USD with a Yahoo historical tier beyond CoinGecko's 365-day window, and precious metals are priced from Yahoo futures.",
          "Currency dropdowns are scoped to the currencies you actually use, with type-to-lookup to add more.",
        ],
      },
      {
        heading: "Security and OAuth",
        items: [
          "OAuth token revocation (RFC 7009) and a Connected Apps screen to manage grants.",
          "Unverified-app and external-redirect warnings on the consent screen, auto-expiry of inactive clients after 60 days, and unspecified-scope logging.",
          "A published /.well-known/security.txt (RFC 9116), the X-Powered-By header removed, and import numeric-bounds hardening.",
          "In-app change password and change email: a non-destructive key re-wrap that keeps your existing sessions valid.",
        ],
      },
      {
        heading: "Loans, admin, and the website",
        items: [
          "Loans and debt v2 with payment-driven or term-driven schedules, six payment frequencies, lease residual value, and account-linked balances.",
          "A sortable admin users table with last-active tracking, an OAuth grants panel, cross-user email oversight, a market-data rate-cache inspector, and an outbound API log.",
          "New comparison pages, a glossary, JSON-LD structured data, and llms.txt for AI crawlers.",
        ],
      },
      {
        heading: "Mobile",
        items: [
          "Finlynq is now live on both the App Store and Google Play, built from a single React Native codebase with the same encryption as the web app.",
        ],
      },
    ],
    githubUrl: "https://github.com/finlynq/finlynq/releases/tag/v3.3.0",
  },
  {
    version: "3.2.0",
    slug: "v3.2.0",
    name: "Finlynq v3.2.0",
    date: "2026-05-21",
    current: false,
    tagline:
      "Finlynq v3.2.0 rebuilt the statement import flow, shipped the v2 auto-categorization rules engine, and hardened the Content Security Policy.",
    summary: [
      "Finlynq v3.2.0 focused on getting money into the app cleanly and safely: a rewritten statement import flow, a more capable auto-categorization rules engine, and a stricter Content Security Policy.",
    ],
    sections: [
      {
        heading: "Import flow rewrite",
        items: [
          "A reworked statement import pipeline with clearer previews, duplicate detection, and per-account handling on the path to the unified import surface.",
        ],
      },
      {
        heading: "Rules engine v2",
        items: [
          "Auto-categorization rules moved to structured JSONB conditions and actions, supporting richer matching and multiple action kinds.",
        ],
      },
      {
        heading: "Security hardening",
        items: [
          "A stricter nonce-based Content Security Policy with strict-dynamic and no unsafe-inline in script-src.",
        ],
      },
    ],
    githubUrl: "https://github.com/finlynq/finlynq/releases/tag/v3.2.0",
  },
];

export const RELEASE_SLUGS = RELEASES.map((r) => r.slug);

export function getRelease(slug: string): Release | undefined {
  return RELEASES.find((r) => r.slug === slug);
}

/** Newest release first (used by the index + the "Latest" pointer). */
export const RELEASES_BY_DATE = [...RELEASES].sort((a, b) =>
  b.date.localeCompare(a.date),
);

export const LATEST_RELEASE = RELEASES_BY_DATE[0];
