"use client";

import { useState, useEffect } from "react";
import { CheckCircle2, XCircle, Copy, Check, Terminal, Zap, Bot, Key, Eye, EyeOff, Globe, Plus, Shield, Upload, Wand2, Radar, Landmark, Globe2, Scissors, Scale, Lightbulb, Briefcase, LifeBuoy } from "lucide-react";

type ClientTab = "claude-desktop" | "claude-web" | "cursor" | "cline" | "windsurf" | "custom";
type StatusState = "checking" | "connected" | "disconnected";

const examplePrompts = [
  { category: "Spending", prompt: "How much did I spend on groceries last month?" },
  { category: "Spending", prompt: "What were my top 5 spending categories this year?" },
  { category: "Budget", prompt: "Am I on track with my budget this month?" },
  { category: "Budget", prompt: "Which budget categories am I over or under?" },
  { category: "Net Worth", prompt: "What is my current net worth?" },
  { category: "Net Worth", prompt: "How has my net worth changed over the last 6 months?" },
  { category: "Goals", prompt: "How close am I to reaching my emergency fund goal?" },
  { category: "Goals", prompt: "What goals should I prioritize this month?" },
  { category: "Investments", prompt: "What is my portfolio return this year?" },
  { category: "Insights", prompt: "Are there any unusual transactions I should review?" },
  { category: "Insights", prompt: "What subscriptions might I want to reconsider?" },
  { category: "Cash Flow", prompt: "What bills are due in the next 30 days?" },
];

type ToolGroupIcon =
  | typeof Upload
  | typeof Wand2
  | typeof Radar
  | typeof Landmark
  | typeof Globe2
  | typeof Scissors
  | typeof Scale
  | typeof Lightbulb
  | typeof Briefcase
  | typeof Bot;

const toolGroups: {
  title: string;
  icon: ToolGroupIcon;
  blurb: string;
  example: string;
  tools: string[];
}[] = [
  {
    title: "Import transactions (CSV / OFX)",
    icon: Upload,
    blurb:
      "Drop a CSV or OFX into Finlynq with the Upload button, then ask Claude to take it from there. Claude lists pending uploads, shows you a preview with duplicate detection, and only commits after you confirm.",
    example: "Preview my pending CSV import and show me the duplicates before you commit.",
    tools: ["list_pending_uploads", "preview_import", "execute_import", "cancel_import"],
  },
  {
    title: "Bulk cleanup",
    icon: Wand2,
    blurb:
      "Recategorize, retag, or delete many transactions at once. Every bulk operation is two steps: a preview that returns a sample and a signed confirmation token, then an execute call that commits. Claude can't skip the confirmation — the token is scoped to the exact payload.",
    example: "Recategorize every Starbucks transaction from the last 90 days as Coffee.",
    tools: [
      "preview_bulk_update",
      "execute_bulk_update",
      "preview_bulk_delete",
      "execute_bulk_delete",
      "preview_bulk_categorize",
      "execute_bulk_categorize",
    ],
  },
  {
    title: "Find and manage subscriptions",
    icon: Radar,
    blurb:
      "Detect recurring charges from your transaction history, then add, update (pause/resume/cancel via status), or delete subscriptions without leaving the chat.",
    example: "Find my subscriptions and add the ones you're confident about.",
    tools: [
      "list_subscriptions",
      "detect_subscriptions",
      "bulk_add_subscriptions",
      "add_subscription",
      "update_subscription",
      "delete_subscription",
      "get_subscription_summary",
    ],
  },
  {
    title: "Manage loans and plan payoff",
    icon: Landmark,
    blurb:
      "Track balances, generate amortization schedules, and compare avalanche vs. snowball payoff plans across all your loans.",
    example: "Show me an avalanche payoff plan with an extra $300 a month.",
    tools: [
      "list_loans",
      "add_loan",
      "update_loan",
      "delete_loan",
      "get_loan_amortization",
      "get_debt_payoff_plan",
    ],
  },
  {
    title: "Currency conversion",
    icon: Globe2,
    blurb:
      "Ask for live or historical FX rates, convert amounts between currencies, or pin your own rate overrides for bookkeeping.",
    example: "What's 1,200 USD in CAD on the day of my last paycheck?",
    tools: [
      "get_fx_rate",
      "convert_amount",
      "list_fx_overrides",
      "set_fx_override",
      "delete_fx_override",
    ],
  },
  {
    title: "Split transactions",
    icon: Scissors,
    blurb:
      "Split a single transaction across multiple categories — useful for $200 grocery runs that include household goods, or Costco trips that mix food and electronics.",
    example: "Split my last Costco run: $120 groceries, $60 household, $40 electronics.",
    tools: ["list_splits", "add_split", "update_split", "delete_split", "replace_splits"],
  },
  {
    title: "Rule management",
    icon: Scale,
    blurb:
      "Create, list, reorder, test, and delete auto-categorization rules. Dry-run any rule against your history before you apply it.",
    example: "Create a rule that categorizes anything containing 'SHELL' as Fuel, and show me what it would match first.",
    tools: [
      "list_rules",
      "create_rule",
      "update_rule",
      "delete_rule",
      "test_rule",
      "reorder_rules",
      "apply_rules_to_uncategorized",
    ],
  },
  {
    title: "Portfolio holdings",
    icon: Briefcase,
    blurb:
      "Manually create, rename, move, or delete portfolio positions (the import pipeline auto-creates them from CSV/ZIP, but for one-offs use these). Plus the read tools for portfolio metrics, performance, deep-dive on a single position, and rebalancing/benchmark insights. Renames cascade to all transactions automatically; deletes leave the transactions in place with the holding link cleared.",
    example: "Add 'VEQT.TO' as a new holding under my RRSP, then move my Apple position to my TFSA.",
    tools: [
      "add_portfolio_holding",
      "update_portfolio_holding",
      "delete_portfolio_holding",
      "get_portfolio_analysis",
      "get_portfolio_performance",
      "analyze_holding",
      "trace_holding_quantity",
      "get_investment_insights",
    ],
  },
  {
    title: "Accounts and aliases",
    icon: Landmark,
    blurb:
      "Add or update accounts, including a short alias (e.g. last 4 digits of a card, or a receipt label) so Claude can match a transaction even when the source document doesn't use the canonical name. The account parameter on every write tool fuzzy-matches your account names and exact-matches aliases — pass either.",
    example: "When I send you receipts that say 'Visa ending 4242', file them under my Chase Sapphire account — set its alias to '4242'.",
    tools: ["add_account", "update_account", "delete_account", "get_account_balances"],
  },
  {
    title: "Suggest payee / category",
    icon: Lightbulb,
    blurb:
      "Before recording a transaction, ask Claude to guess the right category and tags based on your rules and history.",
    example: "I'm about to enter a charge from 'TIM HORTONS #4412' for $7.40 — what category should it be?",
    tools: ["suggest_transaction_details"],
  },
  {
    title: "Reads & dashboards",
    icon: Bot,
    blurb:
      "Balances, net worth, budgets, goals, spending trends, income statements, health score, spotlight alerts, weekly recap, cash flow forecast, anomalies — all the dashboards, queryable in natural language. Portfolio metrics live in the Portfolio holdings card above.",
    example: "Summarize my week: spending, net worth change, and anything unusual.",
    tools: [
      "get_account_balances",
      "get_net_worth",
      "search_transactions",
      "get_budget_summary",
      "get_spending_trends",
      "get_income_statement",
      "get_goals",
      "get_cash_flow_forecast",
      "get_recurring_transactions",
      "get_spotlight_items",
      "get_weekly_recap",
      "get_spending_anomalies",
      "get_financial_health_score",
      "get_categories",
      "finlynq_help",
    ],
  },
];

const workedExamples: { title: string; prompt: string; flow: string }[] = [
  {
    title: "Import a month of transactions from a CSV",
    prompt:
      "I just uploaded my December BMO statement. Preview it, flag the duplicates, and once it looks clean go ahead and import it.",
    flow: "list_pending_uploads → preview_import → (you confirm) → execute_import",
  },
  {
    title: "Find and add subscriptions in one shot",
    prompt:
      "Scan my transactions for recurring charges I might be missing from my subscription list. Show me the candidates with confidence scores and add the ones you're at least 80% sure about.",
    flow: "detect_subscriptions → (you confirm) → bulk_add_subscriptions",
  },
  {
    title: "Refinance plan across every loan",
    prompt:
      "Pull my loans, then compare an avalanche vs. snowball payoff plan assuming I can put an extra $500 a month toward debt. Which gets me debt-free first?",
    flow: "list_loans → get_debt_payoff_plan × 2 (one per strategy)",
  },
  {
    title: "Clean up a year of Uber charges",
    prompt:
      "Every Uber charge before last month should be categorized as Transit instead of Dining. Preview it first and tell me how many rows would change.",
    flow: "preview_bulk_categorize → (you confirm) → execute_bulk_categorize",
  },
];

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="absolute right-2 top-2 p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
      title="Copy to clipboard"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

export default function McpGuidePage() {
  const [activeTab, setActiveTab] = useState<ClientTab>("claude-desktop");
  const [status, setStatus] = useState<StatusState>("checking");
  const [serverUrl, setServerUrl] = useState("http://localhost:3000");
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [apiKeyCopied, setApiKeyCopied] = useState(false);

  useEffect(() => {
    setServerUrl(window.location.origin);
    fetch("/api/healthz")
      .then((r) => setStatus(r.ok ? "connected" : "disconnected"))
      .catch(() => setStatus("disconnected"));
    // Load API key so config snippets are ready to paste
    fetch("/api/settings/api-key")
      .then((r) => r.json())
      .then((d) => { if (d.apiKey) setApiKey(d.apiKey); })
      .catch(() => {});
  }, []);

  const mcpUrl = `${serverUrl}/api/mcp`;
  const displayKey = apiKey ?? "YOUR_API_KEY";

  // Config snippets always use a placeholder — users copy their actual key from the section above
  const httpConfig = JSON.stringify(
    {
      mcpServers: {
        "finlynq": {
          type: "streamable-http",
          url: mcpUrl,
          headers: {
            "Authorization": "Bearer YOUR_API_KEY",
          },
        },
      },
    },
    null,
    2
  );

  const claudeConfig = httpConfig;
  const cursorConfig = httpConfig;
  const windsurfConfig = httpConfig;

  const stdioConfig = JSON.stringify(
    {
      mcpServers: {
        "finlynq": {
          command: "node",
          args: ["/path/to/pf-app/mcp-server/dist/index.js"],
          env: {
            DATABASE_URL: "postgresql://user:pass@localhost:5432/pf",
            PF_USER_ID: "your-user-uuid-from-users-table",
            PF_PASSPHRASE: "your-passphrase",
          },
        },
      },
    },
    null,
    2
  );

  const tabs: { id: ClientTab; label: string; icon: string }[] = [
    { id: "claude-desktop", label: "Claude Desktop", icon: "🤖" },
    { id: "claude-web", label: "Claude Web / Mobile", icon: "🌐" },
    { id: "cursor", label: "Cursor", icon: "⚡" },
    { id: "cline", label: "Cline (VS Code)", icon: "🔌" },
    { id: "windsurf", label: "Windsurf", icon: "🌊" },
    { id: "custom", label: "Custom / Local LLMs", icon: "🛠️" },
  ];

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-4xl px-6 py-10">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 shadow-lg shadow-indigo-500/30">
              <Bot className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-foreground">Connect Your AI</h1>
              <p className="text-sm text-muted-foreground">Ask Claude, Cursor, Windsurf, or any MCP client about your finances</p>
            </div>
          </div>

          {/* Connection Status */}
          <div
            className={`inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium border ${
              status === "connected"
                ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                : status === "disconnected"
                  ? "bg-rose-500/10 border-rose-500/20 text-rose-400"
                  : "bg-muted border-border text-muted-foreground"
            }`}
          >
            {status === "checking" && (
              <div className="h-2 w-2 rounded-full bg-muted-foreground animate-pulse" />
            )}
            {status === "connected" && <CheckCircle2 className="h-4 w-4" />}
            {status === "disconnected" && <XCircle className="h-4 w-4" />}
            {status === "checking" && "Checking MCP server…"}
            {status === "connected" && "MCP server is running — ready to connect"}
            {status === "disconnected" && "MCP server not reachable — is the app running?"}
          </div>
        </div>

        {/* API Key */}
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold text-foreground">Your API Key</h2>
          <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Key className="h-4 w-4 text-indigo-400 shrink-0" />
              <span className="text-sm text-muted-foreground">
                Use this key in the config snippets below to authenticate with the MCP server.
              </span>
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 font-mono text-sm bg-background/60 border border-border rounded-lg px-3 py-2 text-foreground truncate">
                {apiKey
                  ? (apiKeyVisible ? apiKey : `${apiKey.slice(0, 6)}${"•".repeat(20)}${apiKey.slice(-4)}`)
                  : "Hidden — regenerate from Settings to view"}
              </code>
              <button
                onClick={() => setApiKeyVisible(!apiKeyVisible)}
                className="p-2 rounded-lg border border-border bg-background/60 text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
                title={apiKeyVisible ? "Hide key" : "Show key"}
                disabled={!apiKey}
              >
                {apiKeyVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
              <button
                onClick={() => {
                  if (!apiKey) return;
                  navigator.clipboard.writeText(apiKey);
                  setApiKeyCopied(true);
                  setTimeout(() => setApiKeyCopied(false), 2000);
                }}
                className="p-2 rounded-lg border border-border bg-background/60 text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
                title="Copy key"
                disabled={!apiKey}
              >
                {apiKeyCopied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
            {!apiKey && (
              <p className="text-xs text-muted-foreground">
                Sign in at <a href="/cloud" className="underline underline-offset-2 hover:text-foreground">finlynq.com/cloud</a> (free), then visit <a href="/settings/account" className="underline underline-offset-2 hover:text-foreground">Settings → API Key</a> to generate one. We only store a hash — the raw key is shown to you once at creation and cannot be re-shown.
              </p>
            )}
          </div>
        </section>

        {/* Setup Instructions */}
        <section className="mb-10">
          <h2 className="mb-4 text-lg font-semibold text-foreground">Setup Instructions</h2>

          {/* Tab bar */}
          <div className="flex gap-1 mb-4 rounded-xl border border-border bg-muted p-1 overflow-x-auto">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex-shrink-0 flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  activeTab === tab.id
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <span>{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </div>

          <div className="rounded-xl border border-border bg-card p-6 space-y-4">
            {activeTab === "claude-desktop" && (
              <ol className="space-y-5 text-sm text-foreground">
                <p className="text-sm text-muted-foreground">
                  Claude Desktop natively supports MCP. Add Finlynq to your config file and restart Claude.
                </p>
                <li className="flex gap-3">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[11px] font-bold text-primary mt-0.5">
                    1
                  </span>
                  <div>
                    <p className="font-medium mb-1">Open Claude Desktop settings</p>
                    <p className="text-muted-foreground">
                      Go to Claude menu → Settings → Developer → Edit Config
                    </p>
                    <code className="mt-1.5 block text-xs text-muted-foreground leading-relaxed">
                      Mac: ~/Library/Application Support/Claude/claude_desktop_config.json
                      <br />
                      Windows: %APPDATA%\Claude\claude_desktop_config.json
                    </code>
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[11px] font-bold text-primary mt-0.5">
                    2
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium mb-2">Add this to your config file</p>
                    <div className="relative">
                      <pre className="text-xs bg-muted rounded-lg p-4 overflow-x-auto text-muted-foreground leading-relaxed pr-10">
                        {claudeConfig}
                      </pre>
                      <CopyButton text={claudeConfig} />
                    </div>
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[11px] font-bold text-primary mt-0.5">
                    3
                  </span>
                  <div>
                    <p className="font-medium mb-1">Restart Claude Desktop</p>
                    <p className="text-muted-foreground">
                      Finlynq tools will appear in Claude&apos;s tool panel (hammer icon). Make sure
                      Finlynq is running at{" "}
                      <code className="text-xs bg-muted px-1 py-0.5 rounded">{serverUrl}</code>.
                    </p>
                  </div>
                </li>
              </ol>
            )}

            {activeTab === "claude-web" && (
              <div className="space-y-5 text-sm text-foreground">
                {/* Easy-mode callout */}
                <div className="flex items-start gap-3 rounded-xl border border-indigo-500/25 bg-indigo-500/8 p-4">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-indigo-500/15">
                    <Globe className="h-4 w-4 text-indigo-400" />
                  </div>
                  <div>
                    <p className="font-semibold text-foreground mb-0.5">Easiest way to connect</p>
                    <p className="text-xs text-muted-foreground">
                      No config files, no API keys to paste. Just click, log in, and authorize — done in under
                      a minute. Works on claude.ai in any browser, and on the Claude iOS / Android app.
                    </p>
                  </div>
                </div>

                <ol className="space-y-5">
                  <li className="flex gap-3">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[11px] font-bold text-primary mt-0.5">
                      1
                    </span>
                    <div>
                      <p className="font-medium mb-1">Open Claude on the web or mobile</p>
                      <p className="text-muted-foreground">
                        Go to <strong>claude.ai</strong> or open the Claude app on your phone. Start a new
                        conversation or open any existing one.
                      </p>
                    </div>
                  </li>

                  <li className="flex gap-3">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[11px] font-bold text-primary mt-0.5">
                      2
                    </span>
                    <div>
                      <p className="font-medium mb-1">
                        Click the{" "}
                        <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                          <Plus className="h-3 w-3" /> plus
                        </span>{" "}
                        icon in the chat input
                      </p>
                      <p className="text-muted-foreground">
                        Or go to <strong>Settings → Integrations</strong> and click{" "}
                        <strong>Add custom integration</strong>.
                      </p>
                    </div>
                  </li>

                  <li className="flex gap-3">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[11px] font-bold text-primary mt-0.5">
                      3
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium mb-2">Fill in the connector details</p>
                      <div className="rounded-lg border border-border bg-muted/40 divide-y divide-border/50 text-xs overflow-hidden">
                        <div className="flex items-center gap-3 px-3 py-2">
                          <span className="w-28 shrink-0 text-muted-foreground">Name</span>
                          <code className="text-foreground font-mono">Finlynq</code>
                        </div>
                        <div className="flex items-center gap-3 px-3 py-2">
                          <span className="w-28 shrink-0 text-muted-foreground">Server URL</span>
                          <div className="relative flex-1 min-w-0">
                            <code className="text-foreground font-mono break-all">{mcpUrl}</code>
                          </div>
                          <CopyButton text={mcpUrl} />
                        </div>
                        <div className="flex items-center gap-3 px-3 py-2">
                          <span className="w-28 shrink-0 text-muted-foreground">Advanced</span>
                          <span className="text-muted-foreground italic">Leave collapsed — OAuth handles auth</span>
                        </div>
                      </div>
                    </div>
                  </li>

                  <li className="flex gap-3">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[11px] font-bold text-primary mt-0.5">
                      4
                    </span>
                    <div>
                      <p className="font-medium mb-1">Click <strong>Add</strong>, then <strong>Connect</strong></p>
                      <p className="text-muted-foreground">
                        Claude will open a Finlynq authorization page. Log in if prompted, then click{" "}
                        <strong>Allow</strong> to grant access.
                      </p>
                    </div>
                  </li>

                  <li className="flex gap-3">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-[11px] font-bold text-emerald-500 mt-0.5">
                      ✓
                    </span>
                    <div>
                      <p className="font-medium mb-1 text-emerald-500">You&apos;re connected!</p>
                      <p className="text-muted-foreground mb-3">
                        The Finlynq tools are now available in every Claude conversation. Try one of these:
                      </p>
                      <div className="space-y-1.5">
                        {[
                          "What's my current net worth?",
                          "How much did I spend on groceries last month?",
                          "Show me my investment portfolio performance",
                          "Record a $45 Starbucks transaction from yesterday",
                        ].map((prompt) => (
                          <button
                            key={prompt}
                            onClick={() => navigator.clipboard.writeText(prompt)}
                            className="flex w-full items-center gap-2 rounded-lg border border-border/50 bg-card px-3 py-2 text-left text-xs text-muted-foreground hover:border-primary/30 hover:text-foreground transition-colors"
                            title="Click to copy"
                          >
                            <Copy className="h-3 w-3 shrink-0 opacity-40" />
                            {prompt}
                          </button>
                        ))}
                      </div>
                    </div>
                  </li>
                </ol>

                <div className="flex items-start gap-2 rounded-lg bg-amber-500/5 border border-amber-500/20 p-3">
                  <Shield className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-muted-foreground">
                    <strong className="text-foreground">Privacy note:</strong> Claude Web uses OAuth 2.1 — your
                    Finlynq passphrase and financial data are never shared with Anthropic. Only the tool
                    responses (query results) pass through Claude&apos;s servers.
                  </p>
                </div>
              </div>
            )}

            {activeTab === "cursor" && (
              <ol className="space-y-5 text-sm text-foreground">
                <p className="text-sm text-muted-foreground">
                  Cursor supports MCP through its settings. Add Finlynq as an MCP server.
                </p>
                <li className="flex gap-3">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[11px] font-bold text-primary mt-0.5">
                    1
                  </span>
                  <div>
                    <p className="font-medium mb-1">Open Cursor Settings</p>
                    <p className="text-muted-foreground">
                      Go to Cursor → Settings → Cursor Settings → MCP
                    </p>
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[11px] font-bold text-primary mt-0.5">
                    2
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium mb-2">
                      Add to{" "}
                      <code className="text-xs bg-muted px-1 py-0.5 rounded">~/.cursor/mcp.json</code>
                    </p>
                    <div className="relative">
                      <pre className="text-xs bg-muted rounded-lg p-4 overflow-x-auto text-muted-foreground leading-relaxed pr-10">
                        {cursorConfig}
                      </pre>
                      <CopyButton text={cursorConfig} />
                    </div>
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[11px] font-bold text-primary mt-0.5">
                    3
                  </span>
                  <div>
                    <p className="font-medium mb-1">Enable the server</p>
                    <p className="text-muted-foreground">
                      Toggle &quot;finlynq&quot; on in Cursor&apos;s MCP settings panel and reload the window.
                    </p>
                  </div>
                </li>
              </ol>
            )}

            {activeTab === "cline" && (
              <ol className="space-y-5 text-sm text-foreground">
                <p className="text-sm text-muted-foreground">
                  Cline is a VS Code extension that supports MCP servers. Works with Claude, GPT-4, and local
                  models.
                </p>
                <li className="flex gap-3">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[11px] font-bold text-primary mt-0.5">
                    1
                  </span>
                  <div>
                    <p className="font-medium mb-1">Install Cline from VS Code Marketplace</p>
                    <p className="text-muted-foreground">
                      Search &quot;Cline&quot; in the VS Code extensions panel and install it.
                    </p>
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[11px] font-bold text-primary mt-0.5">
                    2
                  </span>
                  <div>
                    <p className="font-medium mb-1">Open Cline&apos;s MCP Servers panel</p>
                    <p className="text-muted-foreground">
                      Click the Cline icon in the sidebar → &quot;MCP Servers&quot; → &quot;Add Server&quot;.
                    </p>
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[11px] font-bold text-primary mt-0.5">
                    3
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium mb-2">Enter this URL for the HTTP transport</p>
                    <div className="relative">
                      <pre className="text-xs bg-muted rounded-lg p-4 overflow-x-auto text-muted-foreground pr-10">
                        {mcpUrl}
                      </pre>
                      <CopyButton text={mcpUrl} />
                    </div>
                  </div>
                </li>
              </ol>
            )}

            {activeTab === "windsurf" && (
              <ol className="space-y-5 text-sm text-foreground">
                <p className="text-sm text-muted-foreground">
                  Windsurf (by Codeium) supports MCP servers via its config file. Add Finlynq to start
                  querying your finances from the AI coding assistant.
                </p>
                <li className="flex gap-3">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[11px] font-bold text-primary mt-0.5">
                    1
                  </span>
                  <div>
                    <p className="font-medium mb-1">Open your Windsurf MCP config</p>
                    <code className="mt-1 block text-xs text-muted-foreground leading-relaxed">
                      Mac/Linux: ~/.codeium/windsurf/mcp_config.json
                      <br />
                      Windows: %USERPROFILE%\.codeium\windsurf\mcp_config.json
                    </code>
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[11px] font-bold text-primary mt-0.5">
                    2
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium mb-2">Add the Finlynq server</p>
                    <div className="relative">
                      <pre className="text-xs bg-muted rounded-lg p-4 overflow-x-auto text-muted-foreground leading-relaxed pr-10">
                        {windsurfConfig}
                      </pre>
                      <CopyButton text={windsurfConfig} />
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Replace <code className="bg-muted px-1 rounded">YOUR_API_KEY</code> with your key from
                      the section above.
                    </p>
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[11px] font-bold text-primary mt-0.5">
                    3
                  </span>
                  <div>
                    <p className="font-medium mb-1">Reload Windsurf</p>
                    <p className="text-muted-foreground">
                      Open the Command Palette → <strong>Windsurf: Reload MCP Servers</strong>. The Finlynq
                      tools will appear in Cascade when you start a new conversation.
                    </p>
                  </div>
                </li>
              </ol>
            )}

            {activeTab === "custom" && (
              <div className="space-y-6 text-sm text-foreground">
                <p className="text-muted-foreground">
                  Any MCP-compatible client can connect via HTTP or stdio. Use this for local LLMs, custom
                  agents, or developer tooling.
                </p>

                <div>
                  <h3 className="font-semibold mb-2 flex items-center gap-2">
                    <Zap className="h-4 w-4 text-amber-400" />
                    HTTP Transport (recommended)
                  </h3>
                  <p className="text-xs text-muted-foreground mb-2">
                    Works with any MCP client that supports Streamable HTTP:
                  </p>
                  <div className="relative">
                    <pre className="text-xs bg-muted rounded-lg p-4 overflow-x-auto text-muted-foreground pr-10">
                      {mcpUrl}
                    </pre>
                    <CopyButton text={mcpUrl} />
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold mb-2 flex items-center gap-2">
                    <Terminal className="h-4 w-4 text-slate-400" />
                    Stdio Transport (self-hosted only)
                  </h3>
                  <p className="text-xs text-muted-foreground mb-2">
                    For self-hosted setups. Requires building the MCP server first:
                  </p>
                  <div className="relative mb-2">
                    <pre className="text-xs bg-muted rounded-lg p-4 overflow-x-auto text-muted-foreground leading-relaxed pr-10">
                      {stdioConfig}
                    </pre>
                    <CopyButton text={stdioConfig} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Build the server:{" "}
                    <code className="bg-muted px-1 py-0.5 rounded">npm run build:mcp</code> in the pf-app
                    directory.
                  </p>
                </div>

                <div className="rounded-lg bg-amber-500/5 border border-amber-500/20 p-4">
                  <p className="text-xs text-muted-foreground">
                    <strong className="text-foreground">Windsurf:</strong> Use the dedicated{" "}
                    <button
                      onClick={() => setActiveTab("windsurf")}
                      className="underline underline-offset-2 text-foreground hover:text-primary transition-colors"
                    >
                      Windsurf tab
                    </button>{" "}
                    for step-by-step setup instructions.
                  </p>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Example Prompts */}
        <section className="mb-10">
          <h2 className="mb-1 text-lg font-semibold text-foreground">Example Prompts</h2>
          <p className="mb-4 text-sm text-muted-foreground">Click any prompt to copy it, then paste into your AI assistant.</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {examplePrompts.map((item, i) => (
              <button
                key={i}
                className="group flex items-start gap-3 rounded-lg border border-border/50 bg-card p-3 hover:border-primary/30 hover:bg-card/80 transition-colors text-left"
                onClick={() => navigator.clipboard.writeText(item.prompt)}
                title="Click to copy"
              >
                <span className="mt-0.5 text-[11px] font-semibold px-1.5 py-0.5 rounded bg-primary/10 text-primary shrink-0">
                  {item.category}
                </span>
                <p className="text-sm text-muted-foreground group-hover:text-foreground transition-colors">
                  {item.prompt}
                </p>
              </button>
            ))}
          </div>
        </section>

        {/* Worked examples — copy-paste prompts that trigger multi-tool flows */}
        <section className="mb-10">
          <h2 className="mb-1 text-lg font-semibold text-foreground">Try a full flow</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Paste any of these into Claude to see a preview / confirm / execute flow end-to-end. Claude asks
            before it commits anything destructive.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {workedExamples.map((ex) => (
              <button
                key={ex.title}
                onClick={() => navigator.clipboard.writeText(ex.prompt)}
                className="group flex flex-col gap-2 rounded-xl border border-border/50 bg-card p-4 text-left hover:border-primary/30 transition-colors"
                title="Click to copy prompt"
              >
                <div className="flex items-center gap-2">
                  <Copy className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0 group-hover:text-foreground transition-colors" />
                  <p className="text-sm font-semibold text-foreground">{ex.title}</p>
                </div>
                <p className="text-sm text-muted-foreground group-hover:text-foreground transition-colors">
                  {ex.prompt}
                </p>
                <p className="mt-auto pt-1 text-[11px] font-mono text-muted-foreground/70">{ex.flow}</p>
              </button>
            ))}
          </div>
        </section>

        {/* What Claude can do — capability groups, not tool-by-tool */}
        <section>
          <h2 className="mb-1 text-lg font-semibold text-foreground">What Claude can do</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            91 tools (HTTP) / 87 (stdio) organized by task. Claude picks the right ones — you describe the outcome in plain English.
            For the full alphabetical tool list with parameters, see{" "}
            <code className="bg-muted px-1 rounded">/api-docs</code> or{" "}
            <code className="bg-muted px-1 rounded">/.well-known/mcp.json</code>.
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            {toolGroups.map((group) => {
              const Icon = group.icon;
              return (
                <div
                  key={group.title}
                  className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                      <Icon className="h-4 w-4 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="text-sm font-semibold text-foreground">{group.title}</h3>
                      <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{group.blurb}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => navigator.clipboard.writeText(group.example)}
                    className="flex items-start gap-2 rounded-lg border border-border/50 bg-muted/40 px-3 py-2 text-left text-xs text-muted-foreground hover:border-primary/30 hover:text-foreground transition-colors"
                    title="Click to copy prompt"
                  >
                    <Copy className="mt-0.5 h-3 w-3 shrink-0 opacity-50" />
                    <span className="italic">&quot;{group.example}&quot;</span>
                  </button>
                  <div className="flex flex-wrap gap-1 pt-1">
                    {group.tools.map((t) => (
                      <code
                        key={t}
                        className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground"
                      >
                        {t}
                      </code>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-4 rounded-lg bg-muted/30 border border-border/50 px-4 py-3">
            <p className="text-xs text-muted-foreground">
              <strong className="text-foreground">How destructive ops stay safe:</strong> bulk updates,
              deletes, imports, and subscription-detection all use a preview → confirm → execute pattern.
              The preview returns a signed token scoped to the exact payload; the execute step rejects
              unless the token matches. Claude can&apos;t skip the preview, and it can&apos;t mutate the
              payload between steps without invalidating the token.
            </p>
          </div>
        </section>

        {/* Troubleshooting */}
        <section className="mt-10 mb-10">
          <h2 className="mb-4 text-lg font-semibold text-foreground flex items-center gap-2">
            <LifeBuoy className="h-5 w-5 text-primary" />
            Troubleshooting
          </h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Common issues and fixes when connecting an AI assistant to Finlynq. Click any item to expand.
          </p>
          <div className="rounded-xl border border-border bg-card divide-y divide-border">
            <details className="group">
              <summary className="cursor-pointer list-none px-5 py-4 text-sm font-medium text-foreground hover:bg-muted/30 transition-colors flex items-center justify-between gap-3">
                <span>&ldquo;Failed to connect&rdquo; or OAuth flow stuck</span>
                <span className="text-muted-foreground text-xs group-open:rotate-180 transition-transform">▾</span>
              </summary>
              <div className="px-5 pb-4 text-sm text-muted-foreground leading-relaxed">
                Sign out of the integration (<strong>Settings → Integrations → Finlynq → Sign out</strong>),
                then restart the OAuth flow from the Claude side. Most common cause: your session expired
                after a Finlynq deploy. We rotate <code className="bg-muted px-1 rounded text-xs">DEPLOY_GENERATION</code>{" "}
                on every release, which force-logs out in-flight tokens for security. Re-OAuth and you&apos;re
                back in within seconds.
              </div>
            </details>

            <details className="group">
              <summary className="cursor-pointer list-none px-5 py-4 text-sm font-medium text-foreground hover:bg-muted/30 transition-colors flex items-center justify-between gap-3">
                <span><code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono">HTTP 401 Unauthorized</code> from <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono">/api/mcp</code></span>
                <span className="text-muted-foreground text-xs group-open:rotate-180 transition-transform">▾</span>
              </summary>
              <div className="px-5 pb-4 text-sm text-muted-foreground leading-relaxed">
                Bearer token expired or missing. For Claude.ai web, re-add the integration from{" "}
                <strong>Settings → Integrations</strong>. For Claude Desktop / Cursor / Windsurf using
                API-key auth, generate a fresh key at{" "}
                <a href="/settings/account" className="underline underline-offset-2 hover:text-foreground">
                  finlynq.com/settings/account
                </a>{" "}
                and replace the old one in your client config.
              </div>
            </details>

            <details className="group">
              <summary className="cursor-pointer list-none px-5 py-4 text-sm font-medium text-foreground hover:bg-muted/30 transition-colors flex items-center justify-between gap-3">
                <span><code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono">HTTP 403 Forbidden</code></span>
                <span className="text-muted-foreground text-xs group-open:rotate-180 transition-transform">▾</span>
              </summary>
              <div className="px-5 pb-4 text-sm text-muted-foreground leading-relaxed">
                The request <code className="bg-muted px-1 rounded text-xs">Origin</code> header isn&apos;t on
                our allowlist. Custom MCP clients should send <code className="bg-muted px-1 rounded text-xs">Origin</code>{" "}
                as one of:{" "}
                <code className="bg-muted px-1 rounded text-xs">claude.ai</code>,{" "}
                <code className="bg-muted px-1 rounded text-xs">claude.com</code>,{" "}
                <code className="bg-muted px-1 rounded text-xs">chatgpt.com</code>,{" "}
                <code className="bg-muted px-1 rounded text-xs">cursor.com</code>,{" "}
                <code className="bg-muted px-1 rounded text-xs">windsurf.dev</code>, or{" "}
                <code className="bg-muted px-1 rounded text-xs">codeium.com</code>. CLI clients that send
                no <code className="bg-muted px-1 rounded text-xs">Origin</code> header at all are allowed
                through.
              </div>
            </details>

            <details className="group">
              <summary className="cursor-pointer list-none px-5 py-4 text-sm font-medium text-foreground hover:bg-muted/30 transition-colors flex items-center justify-between gap-3">
                <span><code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono">HTTP 423 Locked</code></span>
                <span className="text-muted-foreground text-xs group-open:rotate-180 transition-transform">▾</span>
              </summary>
              <div className="px-5 pb-4 text-sm text-muted-foreground leading-relaxed">
                Your encryption key (DEK) isn&apos;t loaded for the current session. This happens after a
                long idle (&gt;2h) or a Finlynq deploy. Sign out of finlynq.com and sign back in to reload
                the DEK, then retry the tool call.
              </div>
            </details>

            <details className="group">
              <summary className="cursor-pointer list-none px-5 py-4 text-sm font-medium text-foreground hover:bg-muted/30 transition-colors flex items-center justify-between gap-3">
                <span>&ldquo;No holdings tracked&rdquo; when running portfolio analysis</span>
                <span className="text-muted-foreground text-xs group-open:rotate-180 transition-transform">▾</span>
              </summary>
              <div className="px-5 pb-4 text-sm text-muted-foreground leading-relaxed">
                If you&apos;re on the public demo account, portfolio data is reseeded nightly — querying
                right after a deploy may return a stale cache. Open a fresh chat and re-query. On your own
                account, ensure every transaction in an investment account is bound to a holding: Finlynq
                requires <code className="bg-muted px-1 rounded text-xs">portfolio_holding_id</code> on
                every row in an <code className="bg-muted px-1 rounded text-xs">is_investment=true</code>{" "}
                account. Cash legs are auto-bound to a per-account Cash sleeve.
              </div>
            </details>

            <details className="group">
              <summary className="cursor-pointer list-none px-5 py-4 text-sm font-medium text-foreground hover:bg-muted/30 transition-colors flex items-center justify-between gap-3">
                <span>Tool call returns &ldquo;stale data&rdquo; after a write</span>
                <span className="text-muted-foreground text-xs group-open:rotate-180 transition-transform">▾</span>
              </summary>
              <div className="px-5 pb-4 text-sm text-muted-foreground leading-relaxed">
                Per-user transaction-aggregation caches are invalidated automatically on every MCP write.
                If you ever see truly stale data in Claude.ai, sign out and back in to clear the per-user
                cache. Long-running conversations don&apos;t hold cached results — every tool call hits the
                live database.
              </div>
            </details>

            <details className="group">
              <summary className="cursor-pointer list-none px-5 py-4 text-sm font-medium text-foreground hover:bg-muted/30 transition-colors flex items-center justify-between gap-3">
                <span>Self-hosted: stdio MCP exits at startup</span>
                <span className="text-muted-foreground text-xs group-open:rotate-180 transition-transform">▾</span>
              </summary>
              <div className="px-5 pb-4 text-sm text-muted-foreground leading-relaxed">
                Set BOTH <code className="bg-muted px-1 rounded text-xs">DATABASE_URL</code> and{" "}
                <code className="bg-muted px-1 rounded text-xs">PF_USER_ID</code> (a UUID matching a row in{" "}
                <code className="bg-muted px-1 rounded text-xs">users.id</code>). The stdio transport has
                no HTTP auth layer — it binds to one user at process startup. Without{" "}
                <code className="bg-muted px-1 rounded text-xs">PF_USER_ID</code> the process exits 1
                immediately.
              </div>
            </details>

            <details className="group">
              <summary className="cursor-pointer list-none px-5 py-4 text-sm font-medium text-foreground hover:bg-muted/30 transition-colors flex items-center justify-between gap-3">
                <span>Self-hosted: stdio refuses create / update on accounts, categories, goals, loans, subscriptions, or holdings</span>
                <span className="text-muted-foreground text-xs group-open:rotate-180 transition-transform">▾</span>
              </summary>
              <div className="px-5 pb-4 text-sm text-muted-foreground leading-relaxed">
                As of the Stream D Phase 4 rollout (2026-05-03), plaintext name columns are physically
                dropped from those six tables — names are stored encrypted under your DEK. The stdio
                transport has no DEK, so it can&apos;t compute the encrypted-name siblings on write. Use
                the HTTP MCP transport or the Finlynq web UI for create/update on those tables. Read tools
                across all six tables continue to work on stdio (names render as &ldquo;—&rdquo; without a DEK).
              </div>
            </details>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Issue not listed? Open a GitHub issue at{" "}
            <a
              href="https://github.com/finlynq/finlynq/issues"
              className="underline underline-offset-2 hover:text-foreground"
              target="_blank"
              rel="noreferrer noopener"
            >
              github.com/finlynq/finlynq/issues
            </a>{" "}
            — we triage daily.
          </p>
        </section>
      </div>
    </div>
  );
}
