import Link from "next/link";
import {
  ArrowRight,
  Shield,
  BarChart3,
  Zap,
  Bot,
  Upload,
  PiggyBank,
  Check,
  Terminal,
  Sparkles,
  TrendingUp,
  Target,
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

const HOW_IT_WORKS = [
  {
    step: "01",
    icon: Upload,
    title: "Import your transactions",
    desc: "Upload CSV or OFX files from any bank. Finlynq auto-detects your format and saves the mapping for next time.",
    color: "text-indigo-400",
    bg: "bg-indigo-400/10",
  },
  {
    step: "02",
    icon: Terminal,
    title: "Connect your AI",
    desc: "Add Finlynq as an MCP server in Claude Desktop, Cursor, or any compatible client. Takes 60 seconds.",
    color: "text-violet-400",
    bg: "bg-violet-400/10",
  },
  {
    step: "03",
    icon: Sparkles,
    title: "Ask anything",
    desc: "\"How much did I spend on dining last month?\" \"Am I on track with my budget?\" \"What's my net worth?\"",
    color: "text-purple-400",
    bg: "bg-purple-400/10",
  },
];

const MCP_PROMPTS = [
  "How much did I spend on groceries last month?",
  "Am I on track with my budgets this month?",
  "What is my current net worth?",
  "Show me any unusual transactions recently",
  "How much have I saved toward my emergency fund?",
  "What's my biggest spending category this quarter?",
];

const PRICING = [
  {
    name: "Self-Hosted",
    price: "Free",
    period: "forever",
    desc: "Run it on your own machine. Total control, total privacy.",
    cta: "Get Started",
    href: "/self-hosted",
    featured: false,
    features: [
      "All features included",
      "SQLite + AES-256 encryption",
      "MCP server (stdio transport)",
      "Local data — never leaves your machine",
      "Community support",
    ],
  },
  {
    name: "Cloud",
    price: "$9",
    period: "/ month",
    desc: "Managed hosting, automatic backups, access from anywhere.",
    cta: "Start Free Trial",
    href: "/cloud?tab=register",
    featured: true,
    features: [
      "Everything in Self-Hosted",
      "Hosted PostgreSQL database",
      "Automatic daily backups",
      "MCP over HTTP (any device)",
      "Email-based transaction import",
      "Priority support",
    ],
  },
  {
    name: "Power User",
    price: "$19",
    period: "/ month",
    desc: "For those who want it all — multiple users, advanced analytics.",
    cta: "Start Free Trial",
    href: "/cloud?tab=register",
    featured: false,
    features: [
      "Everything in Cloud",
      "Up to 5 team members",
      "Advanced tax optimization",
      "Monte Carlo retirement simulation",
      "API access (REST + MCP)",
      "Dedicated support",
    ],
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-dot-pattern ambient-glow">
      {/* ── Header ──────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 border-b border-border/40 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 via-violet-500 to-purple-600 shadow-lg shadow-indigo-500/30">
              <span className="text-xs font-bold text-white tracking-tight">FL</span>
            </div>
            <span className="text-sm font-semibold text-foreground">Finlynq</span>
          </div>

          <nav className="hidden md:flex items-center gap-6 text-sm text-muted-foreground">
            <a href="#features" className="hover:text-foreground transition-colors">Features</a>
            <a href="#how-it-works" className="hover:text-foreground transition-colors">How it works</a>
            <a href="#mcp" className="hover:text-foreground transition-colors">MCP</a>
            <a href="#pricing" className="hover:text-foreground transition-colors">Pricing</a>
          </nav>

          <div className="flex items-center gap-3">
            <Link
              href="/cloud"
              className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              Log In
            </Link>
            <Link
              href="/cloud?tab=register"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-md shadow-primary/20 hover:bg-primary/90 transition-all hover:scale-[1.02] active:scale-[0.99]"
            >
              Sign Up Free
            </Link>
          </div>
        </div>
      </header>

      {/* ── Hero ────────────────────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-6 pt-24 pb-20 text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-4 py-1.5 mb-8">
          <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
          <span className="text-xs font-medium text-primary">
            MCP-powered · 27 financial tools · Works with Claude &amp; Cursor
          </span>
        </div>

        <h1 className="mb-6 text-5xl sm:text-7xl font-extrabold tracking-tight text-foreground leading-[1.05]">
          Track your money.
          <br />
          <span className="text-gradient">Analyze it anywhere.</span>
        </h1>

        <p className="mx-auto mb-10 max-w-2xl text-xl text-muted-foreground leading-relaxed">
          The personal finance app built for the AI era. Import your transactions, connect your AI assistant,
          and ask questions about your finances in plain English.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16">
          <Link
            href="/cloud?tab=register"
            className="flex items-center gap-2 rounded-xl bg-primary px-8 py-4 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30 hover:bg-primary/90 transition-all hover:shadow-primary/40 hover:scale-[1.02] active:scale-[0.99]"
          >
            Start Free Trial
            <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            href="/self-hosted"
            className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            Self-host for free →
          </Link>
        </div>

        {/* Hero mockup */}
        <div className="mx-auto max-w-4xl rounded-2xl border border-border/50 bg-card/50 overflow-hidden shadow-2xl shadow-black/30 glass">
          <div className="border-b border-border/40 bg-muted/20 px-4 py-3 flex items-center gap-2">
            <div className="flex gap-1.5">
              <div className="h-3 w-3 rounded-full bg-rose-500/60" />
              <div className="h-3 w-3 rounded-full bg-amber-500/60" />
              <div className="h-3 w-3 rounded-full bg-emerald-500/60" />
            </div>
            <div className="mx-auto flex items-center gap-2 rounded-md bg-muted/40 px-3 py-1">
              <span className="text-[11px] text-muted-foreground/60">finlynq.com/dashboard</span>
            </div>
          </div>
          <div className="aspect-[16/8] flex items-center justify-center bg-gradient-to-br from-muted/20 to-muted/5">
            <div className="text-center">
              <div className="mb-3 flex justify-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 border border-primary/20">
                  <TrendingUp className="h-7 w-7 text-primary" />
                </div>
              </div>
              <p className="text-sm font-semibold text-foreground">Dashboard preview</p>
              <p className="text-xs text-muted-foreground/60 mt-1">Sign up to see your financial overview</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Features ─────────────────────────────────────────────── */}
      <section id="features" className="mx-auto max-w-6xl px-6 py-20">
        <div className="text-center mb-14">
          <p className="text-xs font-semibold uppercase tracking-widest text-primary/70 mb-3">Features</p>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground">
            Everything you need to track your finances
          </h2>
          <p className="mt-4 text-muted-foreground max-w-xl mx-auto">
            A complete personal finance toolkit — from budgets and portfolios to AI-powered queries and FIRE planning.
          </p>
        </div>

        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-2xl border border-border/50 bg-card p-6 card-hover glow-card">
              <div className={`mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl ${f.bg}`}>
                <f.icon className={`h-5 w-5 ${f.color}`} />
              </div>
              <h3 className="mb-2 text-sm font-semibold text-foreground">{f.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── How it works ─────────────────────────────────────────── */}
      <section id="how-it-works" className="mx-auto max-w-6xl px-6 py-20">
        <div className="text-center mb-14">
          <p className="text-xs font-semibold uppercase tracking-widest text-primary/70 mb-3">How it works</p>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground">
            Up and running in minutes
          </h2>
          <p className="mt-4 text-muted-foreground max-w-xl mx-auto">
            Three steps from signup to asking your AI about your spending.
          </p>
        </div>

        <div className="grid gap-6 sm:grid-cols-3">
          {HOW_IT_WORKS.map((step, i) => (
            <div key={step.step} className="relative rounded-2xl border border-border/50 bg-card p-8 card-hover">
              {i < HOW_IT_WORKS.length - 1 && (
                <div className="hidden sm:block absolute top-1/2 -right-3 -translate-y-1/2 z-10">
                  <ArrowRight className="h-5 w-5 text-muted-foreground/30" />
                </div>
              )}
              <div className="mb-2 text-[11px] font-bold uppercase tracking-widest text-muted-foreground/40">
                Step {step.step}
              </div>
              <div className={`mb-5 inline-flex h-12 w-12 items-center justify-center rounded-xl ${step.bg}`}>
                <step.icon className={`h-6 w-6 ${step.color}`} />
              </div>
              <h3 className="mb-2 text-base font-semibold text-foreground">{step.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{step.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── MCP Differentiator ──────────────────────────────────── */}
      <section id="mcp" className="mx-auto max-w-6xl px-6 py-20">
        <div className="rounded-3xl border border-primary/20 bg-gradient-to-br from-primary/5 via-violet-500/5 to-purple-500/5 p-10 sm:p-16 overflow-hidden relative">
          {/* Decorative orb */}
          <div className="pointer-events-none absolute -top-20 -right-20 h-64 w-64 rounded-full bg-violet-500/10 blur-3xl" />

          <div className="relative grid gap-12 lg:grid-cols-2 items-center">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1 mb-6">
                <Zap className="h-3 w-3 text-primary" />
                <span className="text-xs font-medium text-primary">MCP Server built-in</span>
              </div>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground mb-4">
                Your AI assistant,<br />
                <span className="text-gradient">meets your finances</span>
              </h2>
              <p className="text-muted-foreground leading-relaxed mb-6">
                Finlynq exposes 27 financial tools via the Model Context Protocol. Connect Claude Desktop,
                Cursor, or any MCP-compatible client and start asking questions in plain English.
                No custom code. No exports. Just ask.
              </p>
              <div className="flex flex-col sm:flex-row gap-3">
                <Link
                  href="/cloud?tab=register"
                  className="inline-flex items-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30 hover:bg-primary/90 transition-all hover:scale-[1.02]"
                >
                  Get Started
                  <ArrowRight className="h-4 w-4" />
                </Link>
                <Link
                  href="/mcp-guide"
                  className="inline-flex items-center gap-2 rounded-xl border border-border/60 px-6 py-3 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-border transition-all"
                >
                  View MCP Guide
                </Link>
              </div>
            </div>

            {/* Example prompts */}
            <div className="space-y-3">
              {MCP_PROMPTS.map((prompt, i) => (
                <div
                  key={i}
                  className="flex items-start gap-3 rounded-xl border border-border/40 bg-background/60 px-4 py-3 backdrop-blur-sm"
                >
                  <Bot className="h-4 w-4 text-violet-400 mt-0.5 shrink-0" />
                  <span className="text-sm text-muted-foreground">{prompt}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── Pricing ─────────────────────────────────────────────── */}
      <section id="pricing" className="mx-auto max-w-6xl px-6 py-20">
        <div className="text-center mb-14">
          <p className="text-xs font-semibold uppercase tracking-widest text-primary/70 mb-3">Pricing</p>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground">
            Simple, transparent pricing
          </h2>
          <p className="mt-4 text-muted-foreground max-w-xl mx-auto">
            Start free. Self-host forever. Or let us handle the infrastructure.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          {PRICING.map((plan) => (
            <div
              key={plan.name}
              className={`relative rounded-2xl border p-8 flex flex-col ${
                plan.featured
                  ? "border-primary/50 bg-gradient-to-b from-primary/5 to-card shadow-xl shadow-primary/10"
                  : "border-border/50 bg-card card-hover"
              }`}
            >
              {plan.featured && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="rounded-full bg-primary px-3 py-1 text-[11px] font-semibold text-primary-foreground shadow-md">
                    Most Popular
                  </span>
                </div>
              )}

              <div className="mb-6">
                <h3 className="text-base font-semibold text-foreground mb-1">{plan.name}</h3>
                <div className="flex items-baseline gap-1 mb-2">
                  <span className="text-4xl font-extrabold tracking-tight text-foreground hero-number">
                    {plan.price}
                  </span>
                  <span className="text-sm text-muted-foreground">{plan.period}</span>
                </div>
                <p className="text-sm text-muted-foreground">{plan.desc}</p>
              </div>

              <ul className="space-y-3 mb-8 flex-1">
                {plan.features.map((feat) => (
                  <li key={feat} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                    <Check className="h-4 w-4 text-emerald-400 mt-0.5 shrink-0" />
                    {feat}
                  </li>
                ))}
              </ul>

              <Link
                href={plan.href}
                className={`rounded-xl px-6 py-3 text-sm font-semibold text-center transition-all hover:scale-[1.02] active:scale-[0.99] ${
                  plan.featured
                    ? "bg-primary text-primary-foreground shadow-lg shadow-primary/30 hover:bg-primary/90"
                    : "border border-border/60 text-foreground hover:border-border hover:bg-muted/30"
                }`}
              >
                {plan.cta}
              </Link>
            </div>
          ))}
        </div>
      </section>

      {/* ── Final CTA ───────────────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-6 py-20">
        <div className="rounded-3xl border border-border/50 bg-card p-12 text-center relative overflow-hidden">
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-indigo-500/5 via-violet-500/5 to-purple-500/5" />
          <div className="relative">
            <div className="mb-5 flex justify-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 via-violet-500 to-purple-600 shadow-xl shadow-indigo-500/30">
                <Target className="h-6 w-6 text-white" />
              </div>
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground mb-4">
              Start understanding your finances today
            </h2>
            <p className="text-muted-foreground max-w-lg mx-auto mb-8">
              Join the first personal finance app built for AI assistants.
              Cloud or self-hosted — your data, your rules.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Link
                href="/cloud?tab=register"
                className="flex items-center gap-2 rounded-xl bg-primary px-8 py-4 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30 hover:bg-primary/90 transition-all hover:scale-[1.02]"
              >
                Create Free Account
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/cloud"
                className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                Already have an account? Log in →
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────────── */}
      <footer className="border-t border-border/50 py-10">
        <div className="mx-auto max-w-6xl px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 via-violet-500 to-purple-600">
              <span className="text-[10px] font-bold text-white">FL</span>
            </div>
            <span className="text-sm font-semibold text-foreground">Finlynq</span>
          </div>
          <div className="flex items-center gap-6 text-xs text-muted-foreground/60">
            <Link href="/self-hosted" className="hover:text-muted-foreground transition-colors">Self-host</Link>
            <Link href="/mcp-guide" className="hover:text-muted-foreground transition-colors">MCP Guide</Link>
            <Link href="/api-docs" className="hover:text-muted-foreground transition-colors">API Docs</Link>
            <Link href="/cloud" className="hover:text-muted-foreground transition-colors">Log In</Link>
          </div>
          <p className="text-xs text-muted-foreground/40">
            &copy; {new Date().getFullYear()} Finlynq &mdash; Track here, analyze anywhere
          </p>
        </div>
      </footer>
    </div>
  );
}
