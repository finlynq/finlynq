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

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background ambient-glow noise-bg">
      {/* Nav */}
      <header className="sticky top-0 z-30 flex items-center justify-between px-6 py-4 border-b border-border/50 bg-background/80 backdrop-blur-md">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 via-violet-500 to-purple-600 shadow-sm shadow-indigo-500/30">
            <span className="text-xs font-bold text-white tracking-tight">PF</span>
          </div>
          <span className="font-semibold text-foreground tracking-tight">PersonalFi</span>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/cloud/login"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Sign in
          </Link>
          <Link
            href="/cloud/signup"
            className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 transition-colors"
          >
            Start free trial
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="relative overflow-hidden px-6 py-20 text-center">
          {/* Decorative orbs */}
          <div className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/3 h-[500px] w-[700px] rounded-full bg-indigo-500/[0.06] blur-3xl" />
          <div className="pointer-events-none absolute left-1/4 top-1/2 h-64 w-64 rounded-full bg-violet-500/[0.05] blur-2xl" />

          <div className="relative mx-auto max-w-2xl">
            {/* Badge */}
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/[0.06] px-3 py-1.5 text-xs font-medium text-primary mb-6">
              <Plug className="h-3 w-3" />
              First-party MCP server — 27 tools
            </div>

            <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-foreground leading-tight mb-4">
              Track your money.{" "}
              <span className="text-gradient">Ask anything.</span>
            </h1>

            <p className="text-lg text-muted-foreground leading-relaxed mb-8 max-w-xl mx-auto">
              PersonalFi connects to Claude, Cursor, and any MCP-compatible AI.
              Import your transactions once, then query your finances in plain English — forever.
            </p>

            {/* Prompt examples */}
            <div className="flex flex-col sm:flex-row flex-wrap gap-2 justify-center mb-10">
              {EXAMPLE_PROMPTS.map((p) => (
                <span
                  key={p}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card/60 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur-sm"
                >
                  <Bot className="h-3 w-3 text-violet-400 shrink-0" />
                  {p}
                </span>
              ))}
            </div>

            {/* CTAs */}
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <Link
                href="/cloud/signup"
                className="flex items-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/25 hover:bg-primary/90 transition-all hover:shadow-primary/35 hover:-translate-y-0.5"
              >
                Start free trial
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/self-hosted"
                className="flex items-center gap-2 rounded-xl border border-border bg-card/60 px-6 py-3 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-border/80 hover:bg-accent transition-all backdrop-blur-sm"
              >
                <HardDrive className="h-4 w-4" />
                Self-host for free
              </Link>
            </div>
            <p className="mt-4 text-xs text-muted-foreground/60">
              14-day free trial · No credit card required · Cancel anytime
            </p>
          </div>
        </section>

        {/* Features */}
        <section className="px-6 py-16 border-t border-border/50">
          <div className="mx-auto max-w-4xl">
            <p className="text-center text-xs font-semibold uppercase tracking-widest text-muted-foreground/50 mb-10">
              Everything you need to know your finances
            </p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((f) => (
                <div
                  key={f.title}
                  className="group rounded-xl border border-border bg-card/60 p-5 hover:border-border/80 hover:bg-card transition-all card-hover"
                >
                  <div className={`mb-3 flex h-9 w-9 items-center justify-center rounded-lg ${f.bg}`}>
                    <f.icon className={`h-4.5 w-4.5 ${f.color}`} />
                  </div>
                  <h3 className="text-sm font-semibold text-foreground mb-1">{f.title}</h3>
                  <p className="text-xs text-muted-foreground leading-relaxed">{f.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* MCP callout */}
        <section className="px-6 py-16 border-t border-border/50">
          <div className="mx-auto max-w-2xl text-center">
            <div className="inline-flex items-center justify-center h-12 w-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 shadow-lg shadow-indigo-500/25 mb-5">
              <Plug className="h-5 w-5 text-white" />
            </div>
            <h2 className="text-2xl font-bold tracking-tight text-foreground mb-3">
              "Track your money here, analyze it anywhere."
            </h2>
            <p className="text-muted-foreground text-sm leading-relaxed mb-6 max-w-lg mx-auto">
              PersonalFi is the only personal finance app built with a first-party MCP server.
              Connect your AI assistant and get real answers from your real data — no copy-pasting,
              no screenshots, no hallucinations.
            </p>
            <Link
              href="/cloud/signup"
              className="inline-flex items-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/25 hover:bg-primary/90 transition-all"
            >
              Get started free
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </section>

        {/* Footer */}
        <footer className="px-6 py-8 border-t border-border/50">
          <div className="mx-auto max-w-4xl flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-muted-foreground/50">
            <span>© 2026 PersonalFi · Track here, analyze anywhere</span>
            <div className="flex items-center gap-4">
              <Link href="/self-hosted" className="hover:text-muted-foreground transition-colors">
                Self-hosted
              </Link>
              <a
                href="/.well-known/mcp.json"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-muted-foreground transition-colors"
              >
                MCP server card
              </a>
            </div>
          </div>
        </footer>
      </main>
    </div>
  );
}
