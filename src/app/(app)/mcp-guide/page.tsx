"use client";

import { useState, useEffect } from "react";
import { CheckCircle2, XCircle, Copy, Check, Terminal, Zap, Bot } from "lucide-react";

type ClientTab = "claude-desktop" | "cursor" | "cline" | "chatgpt" | "custom";
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

const tools = [
  { name: "get_account_balances", desc: "Current balance for all accounts" },
  { name: "get_transactions", desc: "Transactions with filters and search" },
  { name: "get_budget_summary", desc: "Budget vs actual spending by category" },
  { name: "get_net_worth", desc: "Net worth snapshot (assets − liabilities)" },
  { name: "get_spending_trends", desc: "Month-by-month spending by category" },
  { name: "get_portfolio_summary", desc: "Investment holdings and performance" },
  { name: "get_financial_health_score", desc: "Composite financial health score" },
  { name: "search_transactions", desc: "Full-text search across transactions" },
  { name: "get_goals", desc: "Goal progress and projected completion" },
  { name: "get_cash_flow_forecast", desc: "Upcoming bills and cash flow" },
  { name: "get_spending_anomalies", desc: "Unusual transactions and patterns" },
  { name: "get_income_statement", desc: "Income vs expenses over a period" },
  { name: "get_weekly_recap", desc: "This week's spending summary" },
  { name: "get_spotlight_items", desc: "Actionable alerts and insights" },
  { name: "add_transaction", desc: "Log a new transaction via AI" },
  { name: "set_budget", desc: "Create or update a budget category" },
  { name: "add_goal", desc: "Create a savings or debt payoff goal" },
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

  const claudeConfig = JSON.stringify(
    {
      mcpServers: {
        "finlynq": {
          type: "streamable-http",
          url: mcpUrl,
          headers: {
            "Authorization": `Bearer ${displayKey}`,
          },
        },
      },
    },
    null,
    2
  );

  const cursorConfig = JSON.stringify(
    {
      mcpServers: {
        "finlynq": {
          type: "streamable-http",
          url: mcpUrl,
          headers: {
            "Authorization": `Bearer ${displayKey}`,
          },
        },
      },
    },
    null,
    2
  );

  const stdioConfig = JSON.stringify(
    {
      mcpServers: {
        "finlynq": {
          command: "node",
          args: ["/path/to/pf-app/mcp-server/dist/index.js"],
          env: {
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
    { id: "cursor", label: "Cursor", icon: "⚡" },
    { id: "cline", label: "Cline (VS Code)", icon: "🔌" },
    { id: "chatgpt", label: "ChatGPT", icon: "💬" },
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
              <p className="text-sm text-muted-foreground">Ask Claude, Cursor, or any MCP client about your finances</p>
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

            {activeTab === "chatgpt" && (
              <div className="space-y-5 text-sm text-foreground">
                <p className="text-muted-foreground">
                  ChatGPT supports remote MCP servers in Projects. You can add Finlynq as a custom connector so ChatGPT can query your financial data.
                </p>
                <ol className="space-y-5">
                  <li className="flex gap-3">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[11px] font-bold text-primary mt-0.5">
                      1
                    </span>
                    <div>
                      <p className="font-medium mb-1">Open a ChatGPT Project</p>
                      <p className="text-muted-foreground">
                        Go to <strong>chatgpt.com</strong>, create or open a Project, then click{" "}
                        <strong>Add tools</strong> in the project sidebar.
                      </p>
                    </div>
                  </li>
                  <li className="flex gap-3">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[11px] font-bold text-primary mt-0.5">
                      2
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium mb-1">Add a remote MCP server</p>
                      <p className="text-muted-foreground mb-2">
                        Choose <strong>MCP Server</strong> → <strong>HTTP</strong> and enter the Finlynq endpoint:
                      </p>
                      <div className="relative">
                        <pre className="text-xs bg-muted rounded-lg p-4 overflow-x-auto text-muted-foreground pr-10">
                          {mcpUrl}
                        </pre>
                        <CopyButton text={mcpUrl} />
                      </div>
                    </div>
                  </li>
                  <li className="flex gap-3">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[11px] font-bold text-primary mt-0.5">
                      3
                    </span>
                    <div>
                      <p className="font-medium mb-1">Authorize the connection</p>
                      <p className="text-muted-foreground">
                        ChatGPT will redirect you to Finlynq to confirm access. After approving, the 27
                        financial tools will be available in your project conversations.
                      </p>
                    </div>
                  </li>
                </ol>
                <div className="rounded-lg bg-amber-500/5 border border-amber-500/20 p-4">
                  <p className="text-xs text-muted-foreground">
                    <strong className="text-foreground">Note:</strong> Remote MCP in ChatGPT is available to
                    Plus and Pro subscribers. If you don&apos;t see the option, use{" "}
                    <button
                      onClick={() => setActiveTab("claude-desktop")}
                      className="underline underline-offset-2 text-foreground hover:text-primary transition-colors"
                    >
                      Claude Desktop
                    </button>{" "}
                    instead — it has the best MCP support.
                  </p>
                </div>
              </div>
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
                    <strong className="text-foreground">ChatGPT:</strong> Use the dedicated{" "}
                    <button
                      onClick={() => setActiveTab("chatgpt")}
                      className="underline underline-offset-2 text-foreground hover:text-primary transition-colors"
                    >
                      ChatGPT tab
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

        {/* Available Tools */}
        <section>
          <h2 className="mb-1 text-lg font-semibold text-foreground">Available Tools</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            {tools.length} highlighted tools — 27 total (21 read + 6 write).
          </p>
          <div className="rounded-xl border border-border overflow-hidden">
            <div className="grid divide-y divide-border/50">
              {tools.map((tool) => (
                <div
                  key={tool.name}
                  className="flex items-center gap-3 px-4 py-2.5 bg-card hover:bg-muted/30 transition-colors"
                >
                  <code className="text-xs font-mono text-primary shrink-0">{tool.name}</code>
                  <span className="text-xs text-muted-foreground ml-auto text-right">{tool.desc}</span>
                </div>
              ))}
            </div>
            <div className="px-4 py-2.5 bg-muted/30 border-t border-border/50">
              <p className="text-xs text-muted-foreground">
                Full tool list and parameters available at{" "}
                <code className="bg-muted px-1 rounded">/api-docs</code> or via{" "}
                <code className="bg-muted px-1 rounded">/.well-known/mcp.json</code>
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
