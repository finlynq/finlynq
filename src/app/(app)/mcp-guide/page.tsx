"use client";

import { useState, useEffect } from "react";
import { CheckCircle2, XCircle, Copy, Check, Terminal, Zap, Bot, Key, Eye, EyeOff, Globe, Plus, Shield } from "lucide-react";

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
                  : "Loading…"}
              </code>
              <button
                onClick={() => setApiKeyVisible(!apiKeyVisible)}
                className="p-2 rounded-lg border border-border bg-background/60 text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
                title={apiKeyVisible ? "Hide key" : "Show key"}
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
