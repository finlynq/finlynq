import Link from "next/link";
import type { Metadata } from "next";
import { Bot, Eye, Lock, Pencil, ShieldAlert, Sparkles, Microscope } from "lucide-react";
import {
  TOOLS,
  TOOL_COUNT_HTTP,
  TOOL_COUNT_STDIO,
  type CatalogTool,
  type ToolCategory,
} from "./tools.generated";

// Static page — generated at build time from the catalog source. No client
// interactivity needed; rendering is pure server component so the full tool
// list is in the initial HTML for crawlers.

export const metadata: Metadata = {
  title: `Finlynq MCP — ${TOOL_COUNT_HTTP} tools for AI personal finance`,
  description: `Complete catalog of the ${TOOL_COUNT_HTTP} HTTP MCP tools Finlynq exposes to Claude, Cursor, Windsurf, and any other MCP client. Covers reads (balances, net worth, budgets, portfolio, goals, FX, spending trends, anomalies), writes (transactions, transfers, trades, accounts, categories, rules, subscriptions, loans, goals, splits, holdings, FX overrides), preview/execute pairs for bulk operations, destructive ops with confirmation tokens, and the unified import staging pipeline.`,
  alternates: { canonical: "/mcp-guide/tools" },
  openGraph: {
    title: `Finlynq MCP — ${TOOL_COUNT_HTTP} tools for AI personal finance`,
    description: `Complete catalog of all ${TOOL_COUNT_HTTP} HTTP and ${TOOL_COUNT_STDIO} stdio MCP tools.`,
    url: "/mcp-guide/tools",
    type: "article",
  },
  twitter: {
    card: "summary",
    title: `Finlynq MCP — ${TOOL_COUNT_HTTP} tools`,
    description: `Catalog of all ${TOOL_COUNT_HTTP} HTTP MCP tools exposed by Finlynq.`,
  },
};

type CategoryMeta = {
  key: ToolCategory;
  label: string;
  blurb: string;
  icon: typeof Eye;
  badgeClass: string;
};

const CATEGORY_ORDER: CategoryMeta[] = [
  {
    key: "read",
    label: "Read",
    blurb:
      "Pure queries — balances, net worth, budgets, transactions, portfolios, goals, loans, FX rates, spending trends, recurring bills, weekly recaps. Read-only. Allowed under both mcp:read and mcp:write OAuth scopes.",
    icon: Eye,
    badgeClass: "bg-emerald-500/15 text-emerald-400 ring-emerald-500/30",
  },
  {
    key: "analyze",
    label: "Analyze",
    blurb:
      "Read-only deep-dives that walk individual holdings through their cost-basis history. Surface per-position attribution rather than aggregate views.",
    icon: Microscope,
    badgeClass: "bg-sky-500/15 text-sky-400 ring-sky-500/30",
  },
  {
    key: "preview",
    label: "Preview",
    blurb:
      "Dry-run pair for every destructive bulk op. Returns a sample of the affected rows plus a signed confirmation token scoped to the exact payload. Read-only — nothing is written.",
    icon: Sparkles,
    badgeClass: "bg-indigo-500/15 text-indigo-300 ring-indigo-500/30",
  },
  {
    key: "execute",
    label: "Execute",
    blurb:
      "Commits a previously-previewed bulk operation. Refuses to run unless the caller passes the matching signed token from preview, so the AI can't skip the confirmation step or mutate the payload between steps.",
    icon: Bot,
    badgeClass: "bg-violet-500/15 text-violet-300 ring-violet-500/30",
  },
  {
    key: "write",
    label: "Write",
    blurb:
      "Mutations — record / update transactions, transfers, trades; create or edit accounts, categories, rules, subscriptions, loans, goals, splits, holdings, snapshots, FX overrides. Requires mcp:write OAuth scope.",
    icon: Pencil,
    badgeClass: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  },
  {
    key: "destructive",
    label: "Destructive",
    blurb:
      "Delete a row, reject a staged import, or cancel an in-flight import. Marked with the MCP destructiveHint so clients can surface a confirmation prompt. Requires mcp:write OAuth scope.",
    icon: ShieldAlert,
    badgeClass: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
  },
];

const TRANSPORT_LABEL: Record<CatalogTool["transport"], string> = {
  http: "HTTP only",
  both: "HTTP + stdio",
};

function groupByCategory(tools: ReadonlyArray<CatalogTool>) {
  const map = new Map<ToolCategory, CatalogTool[]>();
  for (const t of tools) {
    const arr = map.get(t.category) ?? [];
    arr.push(t);
    map.set(t.category, arr);
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => a.name.localeCompare(b.name));
  }
  return map;
}

export default function ToolCatalogPage() {
  const grouped = groupByCategory(TOOLS);
  const totalCount = TOOLS.length;
  const writeScopeCount = TOOLS.filter((t) => t.requiresWriteScope).length;
  const readScopeCount = totalCount - writeScopeCount;
  const stdioCoveredCount = TOOLS.filter((t) => t.transport === "both").length;
  const httpOnlyCount = totalCount - stdioCoveredCount;

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-5xl px-6 py-12">
        {/* Header */}
        <header className="mb-10">
          <div className="mb-2 text-xs font-mono uppercase tracking-widest text-muted-foreground">
            <Link href="/mcp-guide" className="hover:text-foreground transition-colors">
              /mcp-guide
            </Link>{" "}
            / tools
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground">
            Finlynq MCP tool catalog
          </h1>
          <p className="mt-3 text-base text-muted-foreground max-w-2xl leading-relaxed">
            Every tool the Finlynq MCP server exposes — what it does, whether
            it reads or writes, which OAuth scope it needs, and which transports
            (HTTP, stdio) carry it. Source-of-truth is the registration code
            in <code className="text-xs bg-muted px-1.5 py-0.5 rounded">mcp-server/register-tools-pg.ts</code>;
            this page regenerates from that file at build time, so the count
            below is always live with what the server actually serves.
          </p>

          {/* Headline stats */}
          <dl className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="HTTP tools" value={TOOL_COUNT_HTTP.toString()} />
            <Stat label="Stdio tools" value={TOOL_COUNT_STDIO.toString()} />
            <Stat label="Read-only" value={readScopeCount.toString()} />
            <Stat label="Write/destructive" value={writeScopeCount.toString()} />
          </dl>

          <div className="mt-5 flex flex-wrap gap-2 text-xs">
            <Link
              href="/mcp-guide"
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-muted-foreground hover:text-foreground hover:border-primary/30 transition-colors"
            >
              ← How to connect
            </Link>
            <a
              href="https://github.com/finlynq/finlynq/blob/main/pf-app/mcp-server/register-tools-pg.ts"
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-muted-foreground hover:text-foreground hover:border-primary/30 transition-colors"
            >
              View source on GitHub
            </a>
            <Link
              href="/api-docs"
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-muted-foreground hover:text-foreground hover:border-primary/30 transition-colors"
            >
              REST API reference
            </Link>
          </div>
        </header>

        {/* OAuth scope note */}
        <section className="mb-10 rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10">
              <Lock className="h-4 w-4 text-indigo-300" />
            </div>
            <div className="text-sm text-muted-foreground leading-relaxed">
              <p className="text-foreground font-semibold mb-1">
                OAuth scopes filter the tool list per token
              </p>
              <p>
                A token granted only <code className="bg-muted px-1.5 py-0.5 rounded text-xs">mcp:read</code>{" "}
                sees the {readScopeCount} read tools below; out-of-scope tools never
                appear in <code className="bg-muted px-1.5 py-0.5 rounded text-xs">tools/list</code> and
                can&apos;t be invoked. The {writeScopeCount} write/destructive tools
                require <code className="bg-muted px-1.5 py-0.5 rounded text-xs">mcp:write</code>.
                API-key and session-cookie auth methods default to both scopes
                granted (no behavior change for non-OAuth clients).{" "}
                {httpOnlyCount > 0 ? (
                  <>
                    {httpOnlyCount} tool
                    {httpOnlyCount === 1 ? " is" : "s are"} HTTP-only because{" "}
                    {httpOnlyCount === 1 ? "it requires" : "they require"} an
                    encrypted-name (DEK) the stdio transport doesn&apos;t hold.
                  </>
                ) : null}
              </p>
            </div>
          </div>
        </section>

        {/* Tool groups */}
        {CATEGORY_ORDER.map((cat) => {
          const tools = grouped.get(cat.key) ?? [];
          if (tools.length === 0) return null;
          const Icon = cat.icon;
          return (
            <section key={cat.key} id={cat.key} className="mb-10 scroll-mt-8">
              <div className="mb-4 flex items-start gap-3">
                <div
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ring-1 ${cat.badgeClass}`}
                >
                  <Icon className="h-4 w-4" />
                </div>
                <div className="flex-1">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <h2 className="text-lg font-semibold text-foreground">
                      {cat.label}
                    </h2>
                    <span className="text-xs font-mono text-muted-foreground">
                      {tools.length} {tools.length === 1 ? "tool" : "tools"}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground leading-relaxed max-w-3xl">
                    {cat.blurb}
                  </p>
                </div>
              </div>

              <ul className="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
                {tools.map((tool) => (
                  <ToolRow key={tool.name} tool={tool} categoryBadge={cat} />
                ))}
              </ul>
            </section>
          );
        })}

        {/* Safety pattern callout */}
        <section className="mt-12 mb-8 rounded-xl border border-border bg-card p-5">
          <h2 className="text-base font-semibold text-foreground mb-2">
            How destructive operations stay safe
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Every bulk write follows a preview → confirm → execute pattern. The
            preview tool returns a sample of affected rows plus a signed
            confirmation token scoped to the exact payload. The execute tool
            refuses to run unless the caller passes that exact token, so the AI
            can&apos;t skip the preview step or silently mutate the operation
            between calls. The same pattern protects bulk categorize, bulk
            update, bulk delete, category deletion (with FK refusal), and the
            staged-import approve flow.
          </p>
          <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
            Per-write idempotency keys carry through{" "}
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded">bulk_record_transactions</code>
            {" "}and{" "}
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded">approve_staged_rows</code>
            {" "}with a 72-hour replay window — Claude retrying a flaky import
            won&apos;t double-book the rows.
          </p>
        </section>

        {/* Footer */}
        <footer className="mt-12 pt-6 border-t border-border text-xs text-muted-foreground">
          <p>
            Tools are registered in{" "}
            <code className="bg-muted px-1 py-0.5 rounded">
              pf-app/mcp-server/register-tools-pg.ts
            </code>{" "}
            (HTTP) and{" "}
            <code className="bg-muted px-1 py-0.5 rounded">
              pf-app/mcp-server/register-core-tools.ts
            </code>{" "}
            (stdio). Annotations (<code className="bg-muted px-1 py-0.5 rounded">readOnlyHint</code>,{" "}
            <code className="bg-muted px-1 py-0.5 rounded">destructiveHint</code>,{" "}
            <code className="bg-muted px-1 py-0.5 rounded">idempotentHint</code>,{" "}
            <code className="bg-muted px-1 py-0.5 rounded">openWorldHint</code>) are injected by{" "}
            <code className="bg-muted px-1 py-0.5 rounded">auto-annotations.ts</code> from name
            prefixes — same rules drive the categorization above.
          </p>
          <p className="mt-2">
            Spotted a tool description that reads poorly?{" "}
            <a
              href="https://github.com/finlynq/finlynq/issues"
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Open an issue
            </a>{" "}
            — we triage daily.
          </p>
        </footer>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <dt className="text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 text-2xl font-bold text-foreground tabular-nums">
        {value}
      </dd>
    </div>
  );
}

function ToolRow({
  tool,
  categoryBadge,
}: {
  tool: CatalogTool;
  categoryBadge: CategoryMeta;
}) {
  return (
    <li id={`tool-${tool.name}`} className="px-4 py-4 sm:px-5 sm:py-5">
      <div className="flex flex-wrap items-center gap-2 mb-1.5">
        <code className="font-mono text-sm font-semibold text-foreground bg-muted/60 px-2 py-0.5 rounded">
          {tool.name}
        </code>
        <span
          className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ${categoryBadge.badgeClass}`}
        >
          {categoryBadge.label}
        </span>
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground border border-border rounded px-1.5 py-0.5">
          {TRANSPORT_LABEL[tool.transport]}
        </span>
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground border border-border rounded px-1.5 py-0.5">
          scope: {tool.requiresWriteScope ? "mcp:write" : "mcp:read"}
        </span>
        {tool.deprecated ? (
          <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30">
            Deprecated
          </span>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground leading-relaxed">
        {tool.blurb}
      </p>
    </li>
  );
}
