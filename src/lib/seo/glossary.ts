/**
 * Glossary / definitions content for `/glossary` + `/glossary/<slug>`.
 *
 * Net-new, hand-authored, accurate content targeting informational-intent
 * queries ("what is an MCP server", "what is envelope encryption") that also
 * feed AI-assistant citation. Rendered without any markdown dependency (blocks
 * are plain structured data) so there is zero lockfile risk.
 *
 * Add an entry here and it flows into the sitemap, the /glossary index, and
 * llms-full.txt automatically.
 */

export type GlossaryBlock =
  | { type: "p"; text: string }
  | { type: "h2"; text: string }
  | { type: "ul"; items: string[] };

export type GlossaryEntry = {
  slug: string;
  /** Page H1, e.g. "What is an MCP server?" */
  term: string;
  /** Short label for the index card + breadcrumb, e.g. "MCP server". */
  shortTerm: string;
  /** Meta description AND the lead definition paragraph (snippet-friendly). */
  description: string;
  /** Body after the lead definition. */
  blocks: GlossaryBlock[];
  /** Related internal links. */
  related: { label: string; href: string }[];
  /** ISO date last reviewed. */
  lastUpdated: string;
};

const TODAY = "2026-05-29";

export const GLOSSARY: GlossaryEntry[] = [
  {
    slug: "mcp-server",
    term: "What is an MCP server?",
    shortTerm: "MCP server",
    description:
      "An MCP server is a program that exposes tools and data to AI assistants through the Model Context Protocol (MCP), an open standard introduced by Anthropic in 2024 that lets any compatible AI client (Claude, Cursor, Windsurf, and others) call those tools in a uniform way. A personal-finance MCP server lets an AI assistant securely query and act on your financial data without custom integrations or copy-pasting exports.",
    blocks: [
      {
        type: "p",
        text: "Before MCP, connecting an AI assistant to an external system meant building a bespoke integration for each pairing. MCP standardizes that connection: a server advertises a set of tools (each with a name, description, and typed inputs), and any MCP-compatible client can discover and call them. The model decides which tool to call; the server runs it and returns structured results.",
      },
      {
        type: "h2",
        text: "How Finlynq uses MCP",
      },
      {
        type: "p",
        // keep in sync with src/lib/mcp/tool-counts.ts
        text: "Finlynq ships a first-party MCP server, not a community wrapper, exposing 109 HTTP tools and 93 stdio tools across budgets, transactions, portfolios, goals, loans, subscriptions, and rules. It supports three transports:",
      },
      {
        type: "ul",
        items: [
          "Streamable HTTP with OAuth 2.1 and Dynamic Client Registration, for web-based clients like Claude.ai and Claude mobile.",
          "HTTP with a Bearer API key, for scripts and custom agents.",
          "stdio, for local clients like Claude Desktop.",
        ],
      },
      {
        type: "p",
        text: "Because the server is first-party and open source (AGPL v3), you can audit exactly which tools exist and what each one reads or writes before you connect an assistant to your money.",
      },
    ],
    related: [
      { label: "Finlynq MCP guide", href: "/mcp-guide" },
      { label: "Full MCP tool catalog", href: "/mcp-guide/tools" },
      { label: "What is a zero-knowledge personal finance app?", href: "/glossary/zero-knowledge-personal-finance" },
    ],
    lastUpdated: TODAY,
  },
  {
    slug: "envelope-encryption",
    term: "What is envelope encryption?",
    shortTerm: "Envelope encryption",
    description:
      "Envelope encryption is a two-layer key scheme: your data is encrypted with a Data Encryption Key (DEK), and the DEK itself is encrypted (\"wrapped\") by a separate Key Encryption Key (KEK). It is the standard pattern for protecting data so that the key needed to read it is never stored in the clear alongside the data.",
    blocks: [
      {
        type: "p",
        text: "The benefit of the two layers is separation: the large dataset is encrypted once with a fast symmetric key (the DEK), while only the small DEK has to be re-encrypted when the protecting key changes. It also means the system can be designed so the operator never holds a key that can decrypt user data.",
      },
      {
        type: "h2",
        text: "How Finlynq uses envelope encryption",
      },
      {
        type: "p",
        text: "Each Finlynq user has their own DEK. That DEK is wrapped by a KEK derived from the user's password using scrypt (a memory-hard key-derivation function) plus a server-side pepper. Sensitive display fields, like transaction payees, notes, tags, account names, category names, and budget names, are encrypted with AES-256-GCM. The unwrapped DEK only exists in server memory while you're signed in.",
      },
      {
        type: "p",
        text: "The honest trade-off: numeric amounts, dates, and unique IDs are stored unencrypted because the database needs them for totals, sorting, joins, and indexes. Everything name-like is encrypted with a key derived only from your password, so even the operator can't read it. The catch is that if you lose your password without a backup, the encrypted fields can't be recovered.",
      },
    ],
    related: [
      { label: "How Finlynq encrypts your money", href: "/blog/how-finlynq-encrypts-your-money" },
      { label: "Privacy policy", href: "/privacy" },
      { label: "What is a zero-knowledge personal finance app?", href: "/glossary/zero-knowledge-personal-finance" },
    ],
    lastUpdated: TODAY,
  },
  {
    slug: "self-hosted-personal-finance",
    term: "What is self-hosted personal finance?",
    shortTerm: "Self-hosted personal finance",
    description:
      "Self-hosted personal finance means running a personal finance manager (PFM) on infrastructure you control, like your own server, homelab, or VPS, instead of a vendor's cloud. You own the database, the backups, and the network boundary, and your financial data never has to leave hardware you trust.",
    blocks: [
      {
        type: "p",
        text: "People choose self-hosting for privacy (no third party holds your data), longevity (the app keeps working even if a company pivots or shuts down), and control (you decide when to upgrade and who can reach it). The trade-off is that you're responsible for running it: provisioning a server, applying updates, and keeping backups.",
      },
      {
        type: "h2",
        text: "How Finlynq does self-hosting",
      },
      {
        type: "p",
        text: "Finlynq runs from a Docker Compose file with PostgreSQL. The self-hosted edition has the same feature set as the managed cloud, including the first-party MCP server, per-user envelope encryption, and multi-currency investment tracking, with no license fees and no feature gates. It's licensed AGPL v3, so the complete source is public and auditable.",
      },
      {
        type: "p",
        text: "If you'd rather not run infrastructure, the same code is available as a free managed cloud. The point is that self-hosting is a choice, not a downgrade.",
      },
    ],
    related: [
      { label: "Self-host Finlynq with Docker", href: "/self-hosted" },
      { label: "Finlynq vs Firefly III", href: "/vs/firefly-iii" },
      { label: "What is envelope encryption?", href: "/glossary/envelope-encryption" },
    ],
    lastUpdated: TODAY,
  },
  {
    slug: "zero-knowledge-personal-finance",
    term: "What is a zero-knowledge personal finance app?",
    shortTerm: "Zero-knowledge personal finance",
    description:
      "A zero-knowledge personal finance app is designed so that the operator running the service cannot read your sensitive data, even though it is stored on their servers. The encryption keys are derived from something only you know (your password), so the plaintext is mathematically inaccessible to anyone without it.",
    blocks: [
      {
        type: "p",
        text: "\"Zero-knowledge\" here is a design claim about who can decrypt, not a marketing adjective. In a true zero-knowledge design, the server stores only ciphertext and wrapped keys; the key that unlocks them is computed from your password at sign-in and never persisted in the clear.",
      },
      {
        type: "h2",
        text: "How Finlynq applies it, and the honest limits",
      },
      {
        type: "p",
        text: "Finlynq encrypts name-like fields (payees, notes, tags, account names, category names, budget names) with a per-user key derived from your password, so the operator cannot read them. It is not a blanket claim about every byte: numeric amounts, dates, and IDs are stored unencrypted because the database needs them to compute totals and run queries. Finlynq states this trade-off plainly rather than overclaiming.",
      },
      {
        type: "p",
        text: "The practical consequence of a key derived only from your password is that there's no operator-side recovery. If you forget your password and have no backup, the encrypted fields can't be restored, by you or anyone else.",
      },
    ],
    related: [
      { label: "How Finlynq encrypts your money", href: "/blog/how-finlynq-encrypts-your-money" },
      { label: "What is envelope encryption?", href: "/glossary/envelope-encryption" },
      { label: "Privacy policy", href: "/privacy" },
    ],
    lastUpdated: TODAY,
  },
  {
    slug: "lot-tracked-cost-basis",
    term: "What is lot-tracked cost basis?",
    shortTerm: "Lot-tracked cost basis",
    description:
      "Lot-tracked cost basis means recording every purchase of a security as a separate \"lot,\" each with its own quantity, price, and date, so that when you sell, the realized gain is computed against the specific shares sold rather than a single blended average. It produces accurate, tax-relevant gain figures, especially across multiple buys at different prices.",
    blocks: [
      {
        type: "p",
        text: "If you buy the same stock three times at different prices, your account holds three lots. When you sell, the cost basis depends on which lots the sale draws from: FIFO (first-in, first-out), or a specific-lot selection. Average-cost methods blur this; lot tracking preserves it, which matters for tax reporting and for understanding true performance.",
      },
      {
        type: "h2",
        text: "How Finlynq tracks lots",
      },
      {
        type: "p",
        text: "Finlynq records per-purchase lots and computes realized gains by closing specific lots on a sale. It's multi-currency aware, so realized gains can be expressed in your base currency using historical exchange rates at the open and close of each lot, and it supports short positions and dividend reinvestment. Cash sleeves are tracked as explicit holdings so currency-on-currency FX gains surface correctly.",
      },
      {
        type: "p",
        text: "The result is a portfolio view built for people who actually reconcile their investments, not just glance at a balance.",
      },
    ],
    related: [
      { label: "Finlynq vs Ghostfolio", href: "/vs/ghostfolio" },
      { label: "What is an MCP server?", href: "/glossary/mcp-server" },
      { label: "About Finlynq", href: "/about" },
    ],
    lastUpdated: TODAY,
  },
];

export const GLOSSARY_SLUGS = GLOSSARY.map((g) => g.slug);

export function getGlossaryEntry(slug: string): GlossaryEntry | undefined {
  return GLOSSARY.find((g) => g.slug === slug);
}
