import Link from "next/link";
import {
  ArrowRight,
  Plug,
  Shield,
  BarChart3,
  Zap,
  Bot,
  Upload,
  PiggyBank,
  HardDrive,
} from "lucide-react";

const FEATURES = [
  {
    icon: Bot,
    title: "AI-native from day one",
    desc: "Connect Claude, Cursor, or any MCP client. Ask questions in plain English — no dashboards needed.",
    color: "text-violet-400",
    bg: "bg-violet-400/10",
  },
  {
    icon: BarChart3,
    title: "Full financial picture",
    desc: "Accounts, budgets, portfolio, goals, and loans — all in one place. CSV and OFX import with saved templates.",
    color: "text-cyan-400",
    bg: "bg-cyan-400/10",
  },
  {
    icon: Upload,
    title: "Import once, done",
    desc: "Save column mappings as templates. Drop a file and the app auto-matches your bank format.",
    color: "text-amber-400",
    bg: "bg-amber-400/10",
  },
  {
    icon: PiggyBank,
    title: "Envelope budgeting",
    desc: "Month-by-month envelope budgets with rollover support. Know exactly what you have left to spend.",
    color: "text-emerald-400",
    bg: "bg-emerald-400/10",
  },
  {
    icon: Zap,
    title: "27 MCP tools",
    desc: "Read balances, search transactions, forecast cash flow, set budgets, and more — all via your AI.",
    color: "text-yellow-400",
    bg: "bg-yellow-400/10",
  },
  {
    icon: Shield,
    title: "Privacy first",
    desc: "Self-hosted option: your data never leaves your machine. AES-256 encryption with SQLCipher.",
    color: "text-rose-400",
    bg: "bg-rose-400/10",
  },
];

const EXAMPLE_PROMPTS = [
  "How much did I spend on groceries last month?",
  "Am I on track with my budgets this month?",
  "What is my current net worth?",
  "Show me any unusual transactions recently",
];

const features = [
  {
    icon: "🤖",
    title: "Ask Your AI Anything",
    desc: "Connect Claude, Cursor, or any MCP client. Ask \"How much did I spend on groceries?\" and get instant answers from 27 financial tools.",
  },
  {
    icon: "📥",
    title: "Import From Anywhere",
    desc: "Upload CSV or OFX files from any bank. Save import templates so the next upload is one click.",
  },
  {
    icon: "🔒",
    title: "Private By Default",
    desc: "Cloud mode encrypts everything. Self-hosted runs entirely on your machine with SQLCipher AES-256 — your data never leaves.",
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-dot-pattern ambient-glow">
      {/* Header */}
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 via-violet-500 to-purple-600 shadow-lg shadow-indigo-500/30">
            <span className="text-xs font-bold text-white tracking-tight">FL</span>
          </div>
          <span className="text-sm font-semibold text-foreground">Finlynq</span>
        </div>
        <Link
          href="/cloud"
          className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          Sign In
        </Link>
      </header>

      {/* Hero */}
      <main className="mx-auto max-w-5xl px-6 pt-20 pb-32 text-center">
        {/* Badge */}
        <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-4 py-1.5 mb-8">
          <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
          <span className="text-xs font-medium text-primary">
            MCP-powered · 27 financial tools · Works with Claude &amp; Cursor
          </span>
        </div>

        <h1 className="mb-6 text-5xl sm:text-6xl font-extrabold tracking-tight text-foreground leading-[1.05]">
          Track your money.
          <br />
          <span className="text-gradient">Analyze it anywhere.</span>
        </h1>

        <p className="mx-auto mb-10 max-w-xl text-lg text-muted-foreground leading-relaxed">
          The first personal finance app with a built-in MCP server. Connect Claude, Cursor, or any AI
          assistant — then just ask about your finances in plain English.
        </p>

        {/* CTAs */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link
            href="/cloud"
            className="rounded-xl bg-primary px-8 py-3.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30 hover:bg-primary/90 transition-all hover:shadow-primary/40 hover:scale-[1.02] active:scale-[0.99]"
          >
            Start Free Trial
          </Link>
          <Link
            href="/self-hosted"
            className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            Self-host for free →
          </Link>
        </div>

        {/* Demo video placeholder */}
        <div className="mt-16 mx-auto max-w-3xl rounded-2xl border border-border/50 bg-card/50 overflow-hidden shadow-2xl shadow-black/20">
          <div className="aspect-video flex flex-col items-center justify-center bg-muted/30 gap-3">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 border border-primary/20">
              <svg className="h-6 w-6 text-primary" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">60-second demo</p>
              <p className="text-xs text-muted-foreground/50 mt-0.5 text-center">Coming soon</p>
            </div>
          </div>
        </div>

        {/* Feature cards */}
        <div className="mt-20 grid gap-6 sm:grid-cols-3 text-left">
          {features.map((f) => (
            <div key={f.title} className="rounded-xl border border-border/50 bg-card p-6 card-hover">
              <div className="mb-3 text-2xl">{f.icon}</div>
              <h3 className="mb-2 text-sm font-semibold text-foreground">{f.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-border/50 py-8 text-center">
        <p className="text-xs text-muted-foreground/60">
          Finlynq &mdash; Track your money here, analyze it anywhere &mdash;{" "}
          <Link href="/self-hosted" className="hover:text-muted-foreground transition-colors">
            Self-host
          </Link>
        </p>
      </footer>
    </div>
  );
}
