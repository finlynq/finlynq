"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Plug,
  CheckCircle2,
  XCircle,
  Loader2,
  Copy,
  Check,
  ChevronDown,
  ChevronRight,
  Sparkles,
  Terminal,
  Globe,
  BookOpen,
  Zap,
  MessageSquare,
  Bot,
  Server,
  Lock,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { motion, AnimatePresence } from "framer-motion";

// ─── Types ────────────────────────────────────────────────────────────────────

type ConnectionStatus = "checking" | "connected" | "locked" | "error";

type Client = "claude" | "cursor" | "local" | "chatgpt";

// ─── Example Prompts ─────────────────────────────────────────────────────────

const EXAMPLE_PROMPTS = [
  {
    category: "Spending",
    color: "text-amber-400",
    bg: "bg-amber-400/10",
    prompts: [
      "How much did I spend on groceries last month?",
      "What are my top 5 spending categories this year?",
      "Show me any unusual transactions in the last 30 days",
      "Compare my dining spending this month vs last month",
    ],
  },
  {
    category: "Budgets",
    color: "text-emerald-400",
    bg: "bg-emerald-400/10",
    prompts: [
      "Am I on track with my budgets this month?",
      "Which budget categories am I over-spending?",
      "Set my groceries budget to $600 per month",
      "How much do I have left in my entertainment budget?",
    ],
  },
  {
    category: "Net Worth & Goals",
    color: "text-violet-400",
    bg: "bg-violet-400/10",
    prompts: [
      "What is my current net worth?",
      "How has my net worth changed over the last 6 months?",
      "Am I on track to hit my emergency fund goal?",
      "Add a new savings goal: vacation fund, $3,000, by December",
    ],
  },
  {
    category: "Portfolio",
    color: "text-cyan-400",
    bg: "bg-cyan-400/10",
    prompts: [
      "Give me a summary of my investment portfolio",
      "What is my asset allocation across all accounts?",
      "Which holdings have the highest unrealized gains?",
      "What is my portfolio's total return this year?",
    ],
  },
  {
    category: "Cash Flow",
    color: "text-blue-400",
    bg: "bg-blue-400/10",
    prompts: [
      "What does my cash flow look like for next month?",
      "List all my recurring bills and subscriptions",
      "What is my average monthly income vs expenses?",
      "Show me my income statement for Q1",
    ],
  },
  {
    category: "Health & Insights",
    color: "text-rose-400",
    bg: "bg-rose-400/10",
    prompts: [
      "What is my financial health score and how can I improve it?",
      "What should I pay attention to this week?",
      "Find any subscriptions I might be able to cancel",
      "Give me a weekly recap of my finances",
    ],
  },
];

// ─── MCP Tools List ───────────────────────────────────────────────────────────

const MCP_TOOLS = {
  read: [
    { name: "get_account_balances", desc: "All account balances and types" },
    { name: "get_transactions", desc: "Transactions with filters" },
    { name: "get_budget_summary", desc: "Budget vs actual by category" },
    { name: "get_spending_trends", desc: "Monthly spending breakdown" },
    { name: "get_portfolio_summary", desc: "Holdings, values, returns" },
    { name: "get_net_worth", desc: "Assets, liabilities, net worth" },
    { name: "get_net_worth_trend", desc: "Historical net worth snapshots" },
    { name: "get_categories", desc: "Transaction category list" },
    { name: "get_loans", desc: "Loan balances and amortization" },
    { name: "get_goals", desc: "Savings goals and progress" },
    { name: "get_recurring_transactions", desc: "Detected recurring bills" },
    { name: "get_income_statement", desc: "Income vs expense summary" },
    { name: "get_transaction_rules", desc: "Auto-categorization rules" },
    { name: "get_spotlight_items", desc: "Priority financial alerts" },
    { name: "get_weekly_recap", desc: "7-day financial summary" },
    { name: "get_financial_health_score", desc: "6-component health score" },
    { name: "get_spending_anomalies", desc: "Unusual transactions" },
    { name: "get_subscription_summary", desc: "Detected subscriptions" },
    { name: "get_cash_flow_forecast", desc: "30-day cash flow projection" },
    { name: "search_transactions", desc: "Full-text transaction search" },
    { name: "apply_rules_to_uncategorized", desc: "Run categorization engine" },
  ],
  write: [
    { name: "add_transaction", desc: "Create a new transaction" },
    { name: "set_budget", desc: "Set or update a budget limit" },
    { name: "add_goal", desc: "Create a new savings goal" },
    { name: "add_snapshot", desc: "Record net worth snapshot" },
    { name: "categorize_transaction", desc: "Update transaction category" },
    { name: "add_account", desc: "Add a new account" },
  ],
};

// ─── Code Snippets ────────────────────────────────────────────────────────────

function getClaudeDesktopConfig(baseUrl: string, isCloud: boolean) {
  if (isCloud) {
    return JSON.stringify(
      {
        mcpServers: {
          "pf-finance": {
            url: `${baseUrl}/api/mcp`,
          },
        },
      },
      null,
      2
    );
  }
  return JSON.stringify(
    {
      mcpServers: {
        "pf-finance": {
          url: "http://localhost:3000/api/mcp",
        },
      },
    },
    null,
    2
  );
}

function getCursorConfig(baseUrl: string) {
  return JSON.stringify(
    {
      mcpServers: {
        "pf-finance": {
          url: `${baseUrl}/api/mcp`,
          transport: "http",
        },
      },
    },
    null,
    2
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function CodeBlock({ code, language = "json" }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative rounded-lg border border-border bg-muted/40 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted/60">
        <span className="text-[11px] font-mono text-muted-foreground uppercase tracking-wider">
          {language}
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-emerald-400" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <pre className="p-4 text-[13px] font-mono text-foreground overflow-x-auto leading-relaxed">
        {code}
      </pre>
    </div>
  );
}

function SetupStep({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-4">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[13px] font-bold text-primary mt-0.5">
        {number}
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-foreground mb-2">{title}</p>
        {children}
      </div>
    </div>
  );
}

function ClientTab({
  active,
  onClick,
  icon: Icon,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ElementType;
  label: string;
  badge?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 whitespace-nowrap",
        active
          ? "bg-primary text-primary-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground hover:bg-accent"
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {label}
      {badge && (
        <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full font-semibold", active ? "bg-white/20" : "bg-primary/15 text-primary")}>
          {badge}
        </span>
      )}
    </button>
  );
}

// ─── Connection Status ────────────────────────────────────────────────────────

function ConnectionBadge({
  status,
  onRefresh,
}: {
  status: ConnectionStatus;
  onRefresh: () => void;
}) {
  const configs = {
    checking: {
      icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
      label: "Checking…",
      className: "bg-muted text-muted-foreground border-border",
    },
    connected: {
      icon: <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />,
      label: "MCP server reachable",
      className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    },
    locked: {
      icon: <Lock className="h-3.5 w-3.5 text-amber-400" />,
      label: "Database locked",
      className: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    },
    error: {
      icon: <XCircle className="h-3.5 w-3.5 text-rose-400" />,
      label: "Not reachable",
      className: "bg-rose-500/10 text-rose-400 border-rose-500/20",
    },
  };

  const cfg = configs[status];

  return (
    <div className="flex items-center gap-2">
      <div
        className={cn(
          "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border",
          cfg.className
        )}
      >
        {cfg.icon}
        {cfg.label}
      </div>
      <button
        onClick={onRefresh}
        title="Re-check connection"
        className="p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
      >
        <RefreshCw className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function McpGuidePage() {
  const [activeClient, setActiveClient] = useState<Client>("claude");
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("checking");
  const [baseUrl, setBaseUrl] = useState("http://localhost:3000");
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>(
    Object.fromEntries(EXAMPLE_PROMPTS.map((c) => [c.category, true]))
  );

  const checkConnection = async () => {
    setConnectionStatus("checking");
    try {
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "pf-guide", version: "1.0" },
          },
          id: 1,
        }),
      });
      if (res.status === 423) {
        setConnectionStatus("locked");
      } else if (res.ok) {
        setConnectionStatus("connected");
      } else {
        setConnectionStatus("error");
      }
    } catch {
      setConnectionStatus("error");
    }
  };

  useEffect(() => {
    setBaseUrl(window.location.origin);
    checkConnection();
  }, []);

  const toggleCategory = (cat: string) =>
    setExpandedCategories((prev) => ({ ...prev, [cat]: !prev[cat] }));

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: { staggerChildren: 0.06, delayChildren: 0.05 } },
  };
  const itemVariants = {
    hidden: { opacity: 0, y: 12 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.35 } },
  };

  return (
    <motion.div
      className="mx-auto max-w-3xl px-4 py-8 space-y-8"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      {/* Header */}
      <motion.div variants={itemVariants}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 shadow-lg shadow-indigo-500/20">
                <Plug className="h-4.5 w-4.5 text-white" />
              </div>
              <h1 className="text-2xl font-bold tracking-tight text-foreground">MCP Setup Guide</h1>
            </div>
            <p className="text-muted-foreground text-sm max-w-lg">
              Connect your AI assistant to PersonalFi and query your finances in natural language.
              Works with Claude, Cursor, and any MCP-compatible client.
            </p>
          </div>
          <ConnectionBadge status={connectionStatus} onRefresh={checkConnection} />
        </div>
      </motion.div>

      {/* What is MCP */}
      <motion.div variants={itemVariants}>
        <Card className="border-primary/20 bg-primary/[0.03]">
          <CardContent className="p-5">
            <div className="flex gap-3">
              <Sparkles className="h-5 w-5 text-primary shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-foreground text-sm mb-1">
                  What is MCP?
                </p>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  The <strong className="text-foreground">Model Context Protocol</strong> (MCP) lets AI assistants securely read
                  and write your financial data. Once connected, you can ask questions like{" "}
                  <em>"How much did I spend on food last month?"</em> and get accurate answers
                  directly from your data — no copy-pasting, no screenshots.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Setup Instructions */}
      <motion.div variants={itemVariants}>
        <h2 className="text-base font-semibold text-foreground mb-3 flex items-center gap-2">
          <Terminal className="h-4 w-4 text-primary" />
          Connect your AI client
        </h2>

        {/* Client Tabs */}
        <div className="flex gap-1.5 flex-wrap mb-5 p-1 rounded-xl bg-muted/40 border border-border">
          <ClientTab
            active={activeClient === "claude"}
            onClick={() => setActiveClient("claude")}
            icon={Bot}
            label="Claude Desktop"
            badge="Recommended"
          />
          <ClientTab
            active={activeClient === "cursor"}
            onClick={() => setActiveClient("cursor")}
            icon={Terminal}
            label="Cursor"
          />
          <ClientTab
            active={activeClient === "local"}
            onClick={() => setActiveClient("local")}
            icon={Server}
            label="Local LLMs"
          />
          <ClientTab
            active={activeClient === "chatgpt"}
            onClick={() => setActiveClient("chatgpt")}
            icon={MessageSquare}
            label="ChatGPT"
          />
        </div>

        <AnimatePresence mode="wait">
          {activeClient === "claude" && (
            <motion.div
              key="claude"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
              className="space-y-5"
            >
              <div className="space-y-4">
                <SetupStep number={1} title="Install Claude Desktop">
                  <p className="text-sm text-muted-foreground">
                    Download Claude Desktop from{" "}
                    <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">claude.ai/download</span>
                    {" "}and sign in with your Anthropic account.
                  </p>
                </SetupStep>
                <SetupStep number={2} title="Open the MCP configuration file">
                  <p className="text-sm text-muted-foreground mb-2">
                    Find or create this file on your system:
                  </p>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-semibold text-foreground/70">macOS:</span>
                      <code className="font-mono bg-muted px-2 py-0.5 rounded">
                        ~/Library/Application Support/Claude/claude_desktop_config.json
                      </code>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-semibold text-foreground/70">Windows:</span>
                      <code className="font-mono bg-muted px-2 py-0.5 rounded">
                        %APPDATA%\Claude\claude_desktop_config.json
                      </code>
                    </div>
                  </div>
                </SetupStep>
                <SetupStep number={3} title="Add the PersonalFi MCP server">
                  <p className="text-sm text-muted-foreground mb-2">
                    Paste this configuration (or merge it with your existing config):
                  </p>
                  <CodeBlock code={getClaudeDesktopConfig(baseUrl, false)} language="json" />
                  <p className="text-xs text-muted-foreground mt-2">
                    The URL points to the MCP server built into this app. The app must be running when Claude Desktop starts.
                  </p>
                </SetupStep>
                <SetupStep number={4} title="Restart Claude Desktop">
                  <p className="text-sm text-muted-foreground">
                    Fully quit and reopen Claude Desktop. You should see{" "}
                    <strong className="text-foreground">pf-finance</strong> listed under MCP tools (
                    <span className="font-mono text-xs bg-muted px-1 rounded">⚙ MCP</span> icon in the toolbar).
                  </p>
                </SetupStep>
                <SetupStep number={5} title="Try it out">
                  <p className="text-sm text-muted-foreground">
                    Ask Claude: <em className="text-foreground">"What is my net worth?"</em> — Claude will use
                    the MCP tools to fetch your data and respond with a real answer.
                  </p>
                </SetupStep>
              </div>
            </motion.div>
          )}

          {activeClient === "cursor" && (
            <motion.div
              key="cursor"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
              className="space-y-5"
            >
              <div className="space-y-4">
                <SetupStep number={1} title="Open Cursor Settings">
                  <p className="text-sm text-muted-foreground">
                    Go to <strong className="text-foreground">Cursor → Settings → MCP</strong> (or press{" "}
                    <kbd className="font-mono text-xs bg-muted border border-border px-1.5 py-0.5 rounded">⌘,</kbd>{" "}
                    and search for MCP).
                  </p>
                </SetupStep>
                <SetupStep number={2} title="Add the MCP server">
                  <p className="text-sm text-muted-foreground mb-2">
                    Add the following to your <code className="font-mono text-xs bg-muted px-1.5 rounded">.cursor/mcp.json</code> file
                    in your project root, or via the Cursor UI:
                  </p>
                  <CodeBlock code={getCursorConfig(baseUrl)} language="json" />
                </SetupStep>
                <SetupStep number={3} title="Reload and verify">
                  <p className="text-sm text-muted-foreground">
                    Reload Cursor. In the Composer or Chat panel, you should see{" "}
                    <strong className="text-foreground">pf-finance</strong> available as an MCP tool.
                    Try asking: <em className="text-foreground">"Show me my top spending categories this month"</em>.
                  </p>
                </SetupStep>
              </div>
            </motion.div>
          )}

          {activeClient === "local" && (
            <motion.div
              key="local"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
              className="space-y-5"
            >
              <Card className="border-border bg-muted/20">
                <CardContent className="p-4">
                  <p className="text-sm text-muted-foreground">
                    <strong className="text-foreground">LM Studio, Ollama + Open WebUI, and LibreChat</strong> support
                    MCP via HTTP. Any tool that can POST JSON-RPC to an HTTP endpoint can connect to PersonalFi.
                  </p>
                </CardContent>
              </Card>
              <div className="space-y-4">
                <SetupStep number={1} title="Use the Streamable HTTP transport URL">
                  <p className="text-sm text-muted-foreground mb-2">
                    Point your MCP client at:
                  </p>
                  <CodeBlock code={`${baseUrl}/api/mcp`} language="url" />
                </SetupStep>
                <SetupStep number={2} title="LM Studio">
                  <p className="text-sm text-muted-foreground">
                    In LM Studio → <strong className="text-foreground">Developer → MCP Servers</strong>, click{" "}
                    <em>Add server</em>, choose <em>Streamable HTTP</em>, and paste the URL above.
                    Name it <code className="font-mono text-xs bg-muted px-1 rounded">pf-finance</code>.
                  </p>
                </SetupStep>
                <SetupStep number={3} title="Open WebUI (Ollama)">
                  <p className="text-sm text-muted-foreground mb-2">
                    Add a tool server in Open WebUI settings:
                  </p>
                  <CodeBlock
                    code={`Server URL: ${baseUrl}/api/mcp\nType: MCP (Streamable HTTP)`}
                    language="config"
                  />
                </SetupStep>
                <SetupStep number={4} title="stdio transport (advanced)">
                  <p className="text-sm text-muted-foreground mb-2">
                    For clients that prefer stdio, build and run the bundled MCP server directly:
                  </p>
                  <CodeBlock
                    code={`# In the pf-app directory:\nnpm run build:mcp\n\n# Then point your client at:\nnode mcp-server/dist/index.js\n\n# Set the passphrase via environment variable:\nPF_PASSPHRASE=your-passphrase node mcp-server/dist/index.js`}
                    language="bash"
                  />
                </SetupStep>
              </div>
            </motion.div>
          )}

          {activeClient === "chatgpt" && (
            <motion.div
              key="chatgpt"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
              className="space-y-4"
            >
              <Card className="border-amber-500/20 bg-amber-500/[0.04]">
                <CardContent className="p-4 flex gap-3">
                  <Zap className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold text-sm text-foreground mb-1">
                      ChatGPT MCP support is rolling out
                    </p>
                    <p className="text-sm text-muted-foreground">
                      OpenAI is adding native MCP support to ChatGPT. Once available, you can connect
                      PersonalFi the same way as Claude Desktop using the HTTP transport URL.
                    </p>
                  </div>
                </CardContent>
              </Card>
              <div className="space-y-4">
                <SetupStep number={1} title="When MCP is available in your ChatGPT account">
                  <p className="text-sm text-muted-foreground mb-2">
                    Go to <strong className="text-foreground">ChatGPT → Settings → Connected apps → Add MCP server</strong> and use:
                  </p>
                  <CodeBlock code={`${baseUrl}/api/mcp`} language="url" />
                </SetupStep>
                <SetupStep number={2} title="In the meantime, use the Custom GPT approach">
                  <p className="text-sm text-muted-foreground">
                    You can use PersonalFi&apos;s REST API with a Custom GPT. The API docs are available at{" "}
                    <a href="/api-docs" className="text-primary hover:underline">
                      /api-docs
                    </a>{" "}
                    with full OpenAPI schema for all 47 routes.
                  </p>
                </SetupStep>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* Example Prompts */}
      <motion.div variants={itemVariants}>
        <h2 className="text-base font-semibold text-foreground mb-3 flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-primary" />
          Example prompts to try
        </h2>
        <div className="space-y-2">
          {EXAMPLE_PROMPTS.map((category) => (
            <div key={category.category} className="border border-border rounded-xl overflow-hidden">
              <button
                onClick={() => toggleCategory(category.category)}
                className="flex items-center justify-between w-full px-4 py-3 bg-card hover:bg-accent/50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <span className={cn("text-xs font-bold px-2 py-0.5 rounded-full", category.color, category.bg)}>
                    {category.category}
                  </span>
                </div>
                {expandedCategories[category.category] ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
              </button>
              <AnimatePresence initial={false}>
                {expandedCategories[category.category] && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    <div className="px-4 pb-3 pt-1 grid gap-1.5">
                      {category.prompts.map((prompt) => (
                        <PromptChip key={prompt} prompt={prompt} />
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
        </div>
      </motion.div>

      {/* Available Tools */}
      <motion.div variants={itemVariants}>
        <h2 className="text-base font-semibold text-foreground mb-3 flex items-center gap-2">
          <Globe className="h-4 w-4 text-primary" />
          Available MCP tools
          <Badge variant="secondary" className="text-xs font-normal">
            27 tools
          </Badge>
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Card className="border-border">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="h-2 w-2 rounded-full bg-emerald-400" />
                <span className="text-sm font-semibold text-foreground">Read tools</span>
                <Badge variant="secondary" className="text-xs ml-auto">{MCP_TOOLS.read.length}</Badge>
              </div>
              <div className="space-y-1.5">
                {MCP_TOOLS.read.map((t) => (
                  <div key={t.name} className="group">
                    <code className="text-[11px] font-mono text-primary/80">{t.name}</code>
                    <p className="text-[11px] text-muted-foreground">{t.desc}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
          <Card className="border-border">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="h-2 w-2 rounded-full bg-amber-400" />
                <span className="text-sm font-semibold text-foreground">Write tools</span>
                <Badge variant="secondary" className="text-xs ml-auto">{MCP_TOOLS.write.length}</Badge>
              </div>
              <div className="space-y-1.5">
                {MCP_TOOLS.write.map((t) => (
                  <div key={t.name} className="group">
                    <code className="text-[11px] font-mono text-amber-400/80">{t.name}</code>
                    <p className="text-[11px] text-muted-foreground">{t.desc}</p>
                  </div>
                ))}
              </div>
              {/* Spacer for visual balance */}
              <div className="mt-4 pt-4 border-t border-border">
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Write tools create or update data. They require the database to be unlocked
                  and are only accessible from localhost.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </motion.div>

      {/* MCP Discovery */}
      <motion.div variants={itemVariants}>
        <Card className="border-border bg-muted/20">
          <CardContent className="p-4 flex items-start gap-3">
            <Server className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-foreground mb-1">Server discovery</p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                The MCP server advertises itself via{" "}
                <a
                  href="/.well-known/mcp.json"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-primary hover:underline"
                >
                  /.well-known/mcp.json
                </a>{" "}
                — the standard MCP server card. Some clients (e.g. Claude.ai remote) use this for auto-discovery.
                The Streamable HTTP transport is at{" "}
                <code className="font-mono text-primary">/api/mcp</code>.
              </p>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </motion.div>
  );
}

// ─── Prompt Chip ──────────────────────────────────────────────────────────────

function PromptChip({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      onClick={handleCopy}
      className="group flex items-center gap-2 w-full text-left rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
    >
      <span className="flex-1 leading-snug">{prompt}</span>
      <span className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        {copied ? (
          <Check className="h-3.5 w-3.5 text-emerald-400" />
        ) : (
          <Copy className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </span>
    </button>
  );
}
