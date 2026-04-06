"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Bot,
  CheckCircle2,
  XCircle,
  Loader2,
  Copy,
  Check,
  ChevronDown,
  ChevronRight,
  Zap,
  MessageSquare,
  TrendingUp,
  Target,
  PiggyBank,
  AlertCircle,
  ExternalLink,
  Terminal,
  Globe,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Types ───────────────────────────────────────────────────────────────────

type McpStatus = "checking" | "online" | "offline";

type SetupTab = "claude-desktop" | "chatgpt" | "cursor" | "local-llm";

// ─── Code Block with Copy ────────────────────────────────────────────────────

function CodeBlock({ code, lang = "json" }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <div className="relative group mt-3">
      <pre className="rounded-lg bg-[oklch(0.12_0.01_265)] border border-border/50 px-4 py-3 text-[12.5px] leading-relaxed font-mono text-emerald-300 overflow-x-auto">
        <code>{code}</code>
      </pre>
      <button
        onClick={copy}
        className="absolute top-2.5 right-2.5 flex items-center gap-1.5 rounded-md bg-white/[0.08] px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-white/[0.14] transition-all opacity-0 group-hover:opacity-100"
        title="Copy to clipboard"
      >
        {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

// ─── Prompt Card ─────────────────────────────────────────────────────────────

function PromptCard({ prompt, category }: { prompt: string; category: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(prompt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button
      onClick={copy}
      className="group w-full rounded-lg border border-border/60 bg-card/50 px-4 py-3 text-left text-sm text-foreground/80 hover:border-primary/40 hover:bg-card hover:text-foreground transition-all"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="leading-relaxed">{prompt}</span>
        <span className="mt-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5 text-muted-foreground" />}
        </span>
      </div>
    </button>
  );
}

// ─── Setup Section ───────────────────────────────────────────────────────────

function SetupSection({
  id,
  active,
  onToggle,
  icon,
  title,
  subtitle,
  children,
}: {
  id: SetupTab;
  active: boolean;
  onToggle: () => void;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("rounded-xl border transition-colors", active ? "border-primary/40 bg-card" : "border-border/60 bg-card/40")}>
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-4 p-5 text-left"
      >
        <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors", active ? "bg-primary/15" : "bg-secondary/60")}>
          {icon}
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-foreground">{title}</span>
          </div>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>
        {active ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
        )}
      </button>
      {active && <div className="border-t border-border/50 px-5 pb-5 pt-4">{children}</div>}
    </div>
  );
}

// ─── Step ────────────────────────────────────────────────────────────────────

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 mt-4">
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[11px] font-bold text-primary mt-0.5">
        {n}
      </div>
      <div className="flex-1 text-sm text-foreground/80 leading-relaxed">{children}</div>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

const promptCategories = [
  {
    icon: <TrendingUp className="h-4 w-4" />,
    label: "Spending",
    color: "text-amber-400",
    prompts: [
      "How much did I spend last month? Break it down by category.",
      "What are my top 5 spending categories this year?",
      "Show me any unusual transactions in the last 30 days.",
      "How does my spending this month compare to last month?",
      "What did I spend at restaurants and food delivery this quarter?",
    ],
  },
  {
    icon: <PiggyBank className="h-4 w-4" />,
    label: "Budgets",
    color: "text-emerald-400",
    prompts: [
      "How am I tracking against my budgets this month?",
      "Which budget categories am I over or at risk of exceeding?",
      "What's my remaining grocery budget for this month?",
      "Suggest a budget for next month based on my last 3 months of spending.",
      "Am I on track to stay within my total budget this month?",
    ],
  },
  {
    icon: <Target className="h-4 w-4" />,
    label: "Goals",
    color: "text-orange-400",
    prompts: [
      "What are my current savings goals and how am I progressing?",
      "How long until I reach my emergency fund goal at this savings rate?",
      "Which of my goals is furthest behind schedule?",
      "How much do I need to save per month to hit my vacation goal by June?",
    ],
  },
  {
    icon: <TrendingUp className="h-4 w-4" />,
    label: "Net Worth",
    color: "text-cyan-400",
    prompts: [
      "What's my current net worth?",
      "How has my net worth changed over the last 6 months?",
      "What are my biggest assets and liabilities?",
      "What's my debt-to-asset ratio?",
      "Show me my portfolio performance vs. a benchmark.",
    ],
  },
  {
    icon: <Zap className="h-4 w-4" />,
    label: "Actions",
    color: "text-violet-400",
    prompts: [
      "Add a $45 grocery transaction for today.",
      'Set my dining budget to $400 for this month.',
      "Create a new goal: save $5,000 for an emergency fund by December.",
      "Categorize my last uncategorized transactions.",
    ],
  },
];

const STDIO_CONFIG = `{
  "mcpServers": {
    "pf-finance": {
      "command": "node",
      "args": ["/path/to/pf-app/mcp-server/dist/index.js"],
      "env": {
        "PF_PASSPHRASE": "your-passphrase-here"
      }
    }
  }
}`;

const HTTP_CONFIG = `{
  "mcpServers": {
    "pf-finance": {
      "url": "http://localhost:3000/api/mcp",
      "headers": {
        "Content-Type": "application/json"
      }
    }
  }
}`;

const CHATGPT_CONFIG = `https://your-domain.com/api/mcp`;

const CURSOR_CONFIG = `{
  "mcpServers": {
    "pf-finance": {
      "url": "http://localhost:3000/api/mcp"
    }
  }
}`;

const CONTINUE_CONFIG = `{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "streamable-http",
          "url": "http://localhost:3000/api/mcp"
        }
      }
    ]
  }
}`;

export default function McpGuidePage() {
  const [status, setStatus] = useState<McpStatus>("checking");
  const [activeTab, setActiveTab] = useState<SetupTab>("claude-desktop");
  const [activeCategory, setActiveCategory] = useState(0);

  const checkStatus = useCallback(async () => {
    setStatus("checking");
    try {
      const res = await fetch("/api/mcp", {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      // Any HTTP response (even 4xx) means the server is up
      setStatus(res.status < 500 ? "online" : "offline");
    } catch {
      setStatus("offline");
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  const toggleTab = (tab: SetupTab) => {
    setActiveTab((prev) => (prev === tab ? ("" as SetupTab) : tab));
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 pb-20 md:py-10">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 shadow-lg shadow-indigo-500/20">
            <Bot className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">MCP Setup Guide</h1>
            <p className="text-sm text-muted-foreground">Connect your AI assistant to your financial data in minutes</p>
          </div>
        </div>

        {/* Connection Status */}
        <div
          className={cn(
            "mt-4 flex items-center justify-between gap-3 rounded-xl border px-4 py-3",
            status === "online"
              ? "border-emerald-500/30 bg-emerald-500/[0.06]"
              : status === "offline"
              ? "border-rose-500/30 bg-rose-500/[0.06]"
              : "border-border/60 bg-card/40"
          )}
        >
          <div className="flex items-center gap-3">
            {status === "checking" && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            {status === "online" && <CheckCircle2 className="h-4 w-4 text-emerald-400" />}
            {status === "offline" && <XCircle className="h-4 w-4 text-rose-400" />}
            <div>
              <p className={cn("text-sm font-medium", status === "online" ? "text-emerald-400" : status === "offline" ? "text-rose-400" : "text-muted-foreground")}>
                {status === "checking" && "Checking MCP server…"}
                {status === "online" && "MCP server is online"}
                {status === "offline" && "MCP server unreachable"}
              </p>
              {status === "online" && (
                <p className="text-xs text-muted-foreground">
                  27 tools available at <code className="font-mono">http://localhost:3000/api/mcp</code>
                </p>
              )}
              {status === "offline" && (
                <p className="text-xs text-muted-foreground">
                  Make sure the app is running and unlocked, then try again.
                </p>
              )}
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={checkStatus} className="shrink-0 text-xs h-8">
            Refresh
          </Button>
        </div>
      </div>

      {/* What is MCP */}
      <Card className="mb-6">
        <CardContent className="p-5">
          <div className="flex gap-4">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-500/10 mt-0.5">
              <MessageSquare className="h-4 w-4 text-indigo-400" />
            </div>
            <div>
              <h2 className="font-semibold text-foreground mb-1">What is MCP?</h2>
              <p className="text-sm text-muted-foreground leading-relaxed">
                The <strong className="text-foreground">Model Context Protocol</strong> lets AI assistants securely read and manage your financial data in real time.
                Once connected, you can ask natural language questions like <em>"how much did I spend on food last month?"</em> and get instant, accurate answers backed by your actual data — not AI guesses.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {["27 tools", "Read + write", "Local & cloud", "Works with Claude, ChatGPT, Cursor"].map((tag) => (
                  <span key={tag} className="rounded-full border border-border/60 bg-secondary/40 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Setup Instructions */}
      <h2 className="text-base font-semibold text-foreground mb-3">Connect Your AI</h2>
      <div className="space-y-3 mb-8">

        {/* Claude Desktop */}
        <SetupSection
          id="claude-desktop"
          active={activeTab === "claude-desktop"}
          onToggle={() => toggleTab("claude-desktop")}
          icon={<Bot className="h-5 w-5 text-indigo-400" />}
          title="Claude Desktop"
          subtitle="Recommended · Fastest setup · Native MCP support"
        >
          <p className="text-sm text-muted-foreground mb-1">
            Claude Desktop supports MCP natively. Choose <strong className="text-foreground">HTTP</strong> (app must be running) or <strong className="text-foreground">stdio</strong> (standalone server process).
          </p>

          <p className="text-sm font-medium text-foreground mt-5 mb-1">Option A — HTTP transport (easiest)</p>
          <p className="text-xs text-muted-foreground mb-1">App must be running at localhost:3000. Works for both cloud and self-hosted modes.</p>
          <Step n={1}>
            Open Claude Desktop → <strong>Settings</strong> → <strong>Developer</strong> → <strong>Edit Config</strong> (opens <code className="font-mono text-xs bg-secondary/60 px-1 py-0.5 rounded">claude_desktop_config.json</code>).
          </Step>
          <Step n={2}>
            Add the following under <code className="font-mono text-xs bg-secondary/60 px-1 py-0.5 rounded">mcpServers</code>:
            <CodeBlock code={HTTP_CONFIG} />
          </Step>
          <Step n={3}>Save the file and <strong>restart Claude Desktop</strong>. You'll see a hammer icon in the chat input — click it to browse available tools.</Step>

          <div className="my-5 border-t border-border/50" />

          <p className="text-sm font-medium text-foreground mb-1">Option B — stdio transport (self-hosted)</p>
          <p className="text-xs text-muted-foreground mb-1">The MCP server runs as a separate process. Requires the MCP server to be built first.</p>
          <Step n={1}>
            Build the MCP server: <CodeBlock lang="bash" code="cd pf-app && npm run build:mcp" />
          </Step>
          <Step n={2}>
            Add to <code className="font-mono text-xs bg-secondary/60 px-1 py-0.5 rounded">claude_desktop_config.json</code>, replacing the path and passphrase:
            <CodeBlock code={STDIO_CONFIG} />
          </Step>
          <Step n={3}>Restart Claude Desktop. Your passphrase unlocks the encrypted database — it's never sent anywhere.</Step>
        </SetupSection>

        {/* ChatGPT */}
        <SetupSection
          id="chatgpt"
          active={activeTab === "chatgpt"}
          onToggle={() => toggleTab("chatgpt")}
          icon={<Globe className="h-5 w-5 text-emerald-400" />}
          title="ChatGPT"
          subtitle="Requires cloud deployment · OpenAI MCP connector"
        >
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2.5">
            <AlertCircle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
            <p className="text-xs text-muted-foreground">
              ChatGPT MCP connectors require a <strong className="text-foreground">publicly accessible URL</strong>. This works for cloud-hosted PF. For self-hosted, use Claude Desktop instead.
            </p>
          </div>
          <Step n={1}>
            Deploy PF to a public URL (e.g., <code className="font-mono text-xs bg-secondary/60 px-1 py-0.5 rounded">https://finance.yourdomain.com</code>).
          </Step>
          <Step n={2}>
            In ChatGPT, go to <strong>Settings</strong> → <strong>Connectors</strong> → <strong>Add connector</strong> → <strong>MCP</strong>.
          </Step>
          <Step n={3}>
            Enter your MCP server URL:
            <CodeBlock lang="text" code={`https://your-domain.com/api/mcp`} />
          </Step>
          <Step n={4}>Authorize the connection. ChatGPT will discover the 27 available tools automatically.</Step>
          <Step n={5}>Start a new chat and ask a financial question — ChatGPT will call the MCP tools automatically.</Step>
        </SetupSection>

        {/* Cursor */}
        <SetupSection
          id="cursor"
          active={activeTab === "cursor"}
          onToggle={() => toggleTab("cursor")}
          icon={<Terminal className="h-5 w-5 text-violet-400" />}
          title="Cursor"
          subtitle="For developers · Works in Cursor chat and Composer"
        >
          <Step n={1}>
            Open Cursor → <strong>Settings</strong> → search for <strong>MCP</strong> → open <code className="font-mono text-xs bg-secondary/60 px-1 py-0.5 rounded">~/.cursor/mcp.json</code>.
          </Step>
          <Step n={2}>
            Add PF Finance as an MCP server:
            <CodeBlock code={CURSOR_CONFIG} />
          </Step>
          <Step n={3}>Restart Cursor. In any chat, you can now ask financial questions and Cursor will query your data via MCP.</Step>
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-indigo-500/20 bg-indigo-500/[0.05] px-3 py-2.5">
            <Zap className="h-4 w-4 text-indigo-400 shrink-0 mt-0.5" />
            <p className="text-xs text-muted-foreground">
              Tip: Cursor works great for writing scripts or automation that query your financial data — ask it to generate a spending report or CSV export script.
            </p>
          </div>
        </SetupSection>

        {/* Local LLMs */}
        <SetupSection
          id="local-llm"
          active={activeTab === "local-llm"}
          onToggle={() => toggleTab("local-llm")}
          icon={<Terminal className="h-5 w-5 text-cyan-400" />}
          title="Local LLMs (Continue, Zed, etc.)"
          subtitle="Privacy-first · Run models locally with Ollama"
        >
          <p className="text-sm text-muted-foreground mb-2">
            Any MCP-compatible client can connect to PF Finance. Here's how to set it up with <strong className="text-foreground">Continue.dev</strong> (VS Code / JetBrains):
          </p>
          <Step n={1}>
            Install <a href="https://www.continue.dev" target="_blank" rel="noopener" className="text-primary underline underline-offset-2 hover:no-underline">Continue.dev</a> and <a href="https://ollama.com" target="_blank" rel="noopener" className="text-primary underline underline-offset-2 hover:no-underline">Ollama</a>.
          </Step>
          <Step n={2}>
            Open <code className="font-mono text-xs bg-secondary/60 px-1 py-0.5 rounded">~/.continue/config.json</code> and add:
            <CodeBlock code={CONTINUE_CONFIG} />
          </Step>
          <Step n={3}>Reload Continue. In the chat panel, ask financial questions — Continue will call the MCP tools against your local PF data.</Step>
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-cyan-500/20 bg-cyan-500/[0.05] px-3 py-2.5">
            <CheckCircle2 className="h-4 w-4 text-cyan-400 shrink-0 mt-0.5" />
            <p className="text-xs text-muted-foreground">
              Other compatible clients: <strong className="text-foreground">Zed</strong>, <strong className="text-foreground">Windsurf</strong>, <strong className="text-foreground">Jan</strong>, and any client that supports the MCP Streamable HTTP transport.
            </p>
          </div>
        </SetupSection>
      </div>

      {/* Example Prompts */}
      <h2 className="text-base font-semibold text-foreground mb-1">Example Prompts</h2>
      <p className="text-sm text-muted-foreground mb-4">Click any prompt to copy it, then paste into your AI assistant.</p>

      {/* Category tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1 mb-4">
        {promptCategories.map((cat, i) => (
          <button
            key={cat.label}
            onClick={() => setActiveCategory(i)}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-all",
              activeCategory === i
                ? "border-primary/50 bg-primary/10 text-primary"
                : "border-border/60 bg-secondary/40 text-muted-foreground hover:text-foreground hover:border-border"
            )}
          >
            <span className={activeCategory === i ? "text-primary" : cat.color}>{cat.icon}</span>
            {cat.label}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {promptCategories[activeCategory].prompts.map((p) => (
          <PromptCard key={p} prompt={p} category={promptCategories[activeCategory].label} />
        ))}
      </div>

      {/* Footer note */}
      <div className="mt-8 rounded-xl border border-border/50 bg-card/40 px-5 py-4">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-foreground mb-0.5">Data stays on your machine</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              The MCP server only exposes tools to read and write your local database. No data is sent to any third-party service — your AI assistant queries PF directly via localhost. The connection is as private as the app itself.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
