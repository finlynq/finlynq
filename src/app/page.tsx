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
  Lock,
  Globe,
  Code2,
  DollarSign,
  Key,
  AlertTriangle,
  EyeOff,
} from "lucide-react";

/* ─── Data ─────────────────────────────────────────────────────────────────── */

const STATS = [
  { value: "27+", label: "MCP tools" },
  { value: "AES-256", label: "Encryption" },
  { value: "6", label: "Import formats" },
  { value: "100%", label: "Local-first" },
];

const FEATURES = [
  {
    icon: Bot,
    title: "AI-native from day one",
    desc: "Connect Claude, Cursor, or any MCP client. Ask questions in plain English — no dashboards required.",
    color: "text-violet-500",
    bg: "bg-violet-50 dark:bg-violet-500/10",
    border: "border-violet-100 dark:border-violet-500/20",
  },
  {
    icon: BarChart3,
    title: "Full financial picture",
    desc: "Accounts, budgets, portfolio, goals, and loans in one place. CSV and OFX import with saved templates.",
    color: "text-cyan-500",
    bg: "bg-cyan-50 dark:bg-cyan-500/10",
    border: "border-cyan-100 dark:border-cyan-500/20",
  },
  {
    icon: Upload,
    title: "Import once, done",
    desc: "Save column mappings as templates. Drop a file and Finlynq auto-matches your bank format.",
    color: "text-amber-500",
    bg: "bg-amber-50 dark:bg-amber-500/10",
    border: "border-amber-100 dark:border-amber-500/20",
  },
  {
    icon: PiggyBank,
    title: "Envelope budgeting",
    desc: "Month-by-month envelope budgets with rollover. Know exactly what you have left to spend.",
    color: "text-emerald-500",
    bg: "bg-emerald-50 dark:bg-emerald-500/10",
    border: "border-emerald-100 dark:border-emerald-500/20",
  },
  {
    icon: TrendingUp,
    title: "Portfolio & investments",
    desc: "Track holdings with live prices, XIRR returns, and benchmarks against major indices.",
    color: "text-blue-500",
    bg: "bg-blue-50 dark:bg-blue-500/10",
    border: "border-blue-100 dark:border-blue-500/20",
  },
  {
    icon: Shield,
    title: "Privacy first",
    desc: "Self-hosted option: your data never leaves your machine. AES-256 encryption via SQLCipher.",
    color: "text-rose-500",
    bg: "bg-rose-50 dark:bg-rose-500/10",
    border: "border-rose-100 dark:border-rose-500/20",
  },
];

const HOW_IT_WORKS = [
  {
    step: "01",
    icon: Upload,
    title: "Import your transactions",
    desc: "Upload CSV or OFX files from any bank. Finlynq remembers your column mappings so the next import is one click.",
    color: "text-indigo-500",
    bg: "bg-indigo-50 dark:bg-indigo-500/10",
  },
  {
    step: "02",
    icon: Terminal,
    title: "Connect your AI",
    desc: "Add Finlynq as an MCP server in Claude Desktop, Cursor, or any compatible client. Takes under 60 seconds.",
    color: "text-violet-500",
    bg: "bg-violet-50 dark:bg-violet-500/10",
  },
  {
    step: "03",
    icon: Sparkles,
    title: "Ask anything",
    desc: "\"How much did I spend on dining?\" \"Am I on track with my budget?\" \"What's my net worth?\" — just ask.",
    color: "text-purple-500",
    bg: "bg-purple-50 dark:bg-purple-500/10",
  },
];

const MCP_PROMPTS = [
  { q: "How much did I spend on groceries last month?", a: "$312.40 — up 8% vs October" },
  { q: "Am I on track with my budgets this month?", a: "3 of 8 categories within budget" },
  { q: "What is my current net worth?", a: "$84,210 — up $1,240 this month" },
  { q: "Show me any unusual transactions recently", a: "Found 2 anomalies in the last 30 days" },
];

const PRICING = [
  {
    name: "Self-Hosted",
    price: "Free",
    period: "forever",
    desc: "Full control. Your hardware, your data.",
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
    desc: "Managed hosting with automatic backups.",
    cta: "Start Free Trial",
    href: "/cloud?tab=register",
    featured: true,
    features: [
      "Everything in Self-Hosted",
      "Hosted PostgreSQL database",
      "Automatic daily backups",
      "MCP over HTTP (access anywhere)",
      "Email-based transaction import",
      "Priority support",
    ],
  },
  {
    name: "Power User",
    price: "$19",
    period: "/ month",
    desc: "For power users who want it all.",
    cta: "Start Free Trial",
    href: "/cloud?tab=register",
    featured: false,
    features: [
      "Everything in Cloud",
      "Up to 5 team members",
      "Advanced tax optimization",
      "Monte Carlo retirement sim",
      "REST API access",
      "Dedicated support",
    ],
  },
];

const TRUST = [
  { icon: Lock, label: "AES-256 encrypted" },
  { icon: Globe, label: "Self-hostable" },
  { icon: Code2, label: "Open protocol (MCP)" },
  { icon: DollarSign, label: "No bank credentials" },
];

const FOOTER_LINKS = {
  Product: [
    { label: "Features", href: "#features" },
    { label: "How it works", href: "#how-it-works" },
    { label: "Pricing", href: "#pricing" },
    { label: "MCP Guide", href: "/mcp-guide" },
    { label: "API Docs", href: "/api-docs" },
  ],
  Hosting: [
    { label: "Cloud", href: "/cloud?tab=register" },
    { label: "Self-Hosted", href: "/self-hosted" },
  ],
  Account: [
    { label: "Log In", href: "/cloud" },
    { label: "Sign Up", href: "/cloud?tab=register" },
    { label: "Dashboard", href: "/dashboard" },
  ],
};

/* ─── Page ──────────────────────────────────────────────────────────────────── */

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3.5">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2.5 group">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 via-violet-500 to-purple-600 shadow-md shadow-indigo-500/25 transition-all group-hover:shadow-indigo-500/40 group-hover:scale-105">
              <span className="text-xs font-bold text-white tracking-tight">FL</span>
            </div>
            <span className="text-sm font-semibold tracking-tight">Finlynq</span>
          </Link>

          {/* Nav links */}
          <nav className="hidden md:flex items-center gap-1">
            {["Features", "How it works", "MCP", "Pricing"].map((label) => (
              <a
                key={label}
                href={`#${label.toLowerCase().replace(" ", "-")}`}
                className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground rounded-md hover:bg-muted/50 transition-all"
              >
                {label}
              </a>
            ))}
          </nav>

          {/* Auth buttons */}
          <div className="flex items-center gap-2">
            <Link
              href="/cloud"
              className="hidden sm:inline-flex px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground rounded-lg hover:bg-muted/50 transition-all"
            >
              Log In
            </Link>
            <Link
              href="/cloud?tab=register"
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm shadow-primary/20 hover:bg-primary/90 hover:shadow-primary/30 hover:scale-[1.02] active:scale-[0.99] transition-all"
            >
              Sign Up Free
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      </header>

      {/* ── Hero ───────────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden bg-dot-pattern">
        {/* Gradient backdrop */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-primary/5 via-background to-background" />
        <div className="pointer-events-none absolute -top-40 left-1/2 -translate-x-1/2 h-96 w-[700px] rounded-full bg-gradient-to-r from-indigo-500/10 via-violet-500/8 to-purple-500/10 blur-3xl" />

        <div className="relative mx-auto max-w-5xl px-5 pt-20 pb-24 text-center">
          {/* Badge */}
          <div className="anim-fade-in inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/8 px-4 py-1.5 mb-7 text-xs font-medium text-primary">
            <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
            MCP-powered · 27 financial tools · Works with Claude, Cursor, Windsurf &amp; more
          </div>

          {/* Headline */}
          <h1 className="anim-fade-up anim-delay-1 mb-6 text-5xl sm:text-6xl lg:text-7xl font-extrabold tracking-tight leading-[1.04] text-foreground">
            Track your money.
            <br />
            <span className="text-gradient">Analyze it anywhere.</span>
          </h1>

          {/* Subheadline */}
          <p className="anim-fade-up anim-delay-2 mx-auto mb-10 max-w-2xl text-lg sm:text-xl text-muted-foreground leading-relaxed font-normal">
            The personal finance app built for the AI era. Encrypted, private, and yours —
            import your bank data, connect Claude or Cursor, and ask questions about your
            money in plain English.
          </p>

          {/* CTAs */}
          <div className="anim-fade-up anim-delay-3 flex flex-col sm:flex-row items-center justify-center gap-4 mb-16">
            <Link
              href="/cloud?tab=register"
              className="flex items-center gap-2 rounded-xl bg-primary px-8 py-3.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/25 hover:bg-primary/90 hover:shadow-primary/35 hover:scale-[1.02] active:scale-[0.99] transition-all w-full sm:w-auto justify-center"
            >
              Start Free Trial
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="/self-hosted"
              className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              Self-host for free →
            </Link>
          </div>

          {/* App mockup frame */}
          <div className="anim-scale-in anim-delay-4 mx-auto max-w-4xl rounded-2xl border border-border/60 bg-card shadow-2xl shadow-black/10 dark:shadow-black/40 overflow-hidden">
            <div className="flex items-center gap-2 border-b border-border/50 bg-muted/30 px-4 py-3">
              <div className="flex gap-1.5">
                <div className="h-3 w-3 rounded-full bg-rose-400/70" />
                <div className="h-3 w-3 rounded-full bg-amber-400/70" />
                <div className="h-3 w-3 rounded-full bg-emerald-400/70" />
              </div>
              <div className="mx-auto rounded-md bg-muted/60 px-3 py-0.5">
                <span className="text-[11px] text-muted-foreground/60 font-mono">finlynq.com/dashboard</span>
              </div>
            </div>
            <div className="relative aspect-[16/7] bg-gradient-to-br from-muted/20 via-background to-muted/10 flex items-center justify-center">
              <div className="text-center space-y-3">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 border border-primary/20">
                  <TrendingUp className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">Your dashboard awaits</p>
                  <p className="text-xs text-muted-foreground mt-1">Sign up to see your financial overview</p>
                </div>
                <Link
                  href="/cloud?tab=register"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary/10 border border-primary/20 px-4 py-2 text-xs font-medium text-primary hover:bg-primary/20 transition-all"
                >
                  Get started →
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Stats bar ──────────────────────────────────────────────────────── */}
      <section className="border-y border-border/50 bg-muted/30">
        <div className="mx-auto max-w-5xl px-5 py-6 grid grid-cols-2 sm:grid-cols-4 gap-6">
          {STATS.map((s) => (
            <div key={s.label} className="text-center">
              <div className="text-2xl font-extrabold tracking-tight text-foreground hero-number">{s.value}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Features ───────────────────────────────────────────────────────── */}
      <section id="features" className="mx-auto max-w-6xl px-5 py-24">
        <div className="text-center mb-16">
          <p className="text-xs font-semibold uppercase tracking-widest text-primary mb-3 opacity-70">Features</p>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground leading-tight">
            Everything you need to master your finances
          </h2>
          <p className="mt-4 text-lg text-muted-foreground max-w-xl mx-auto leading-relaxed">
            A complete personal finance toolkit — from budgets and portfolios
            to AI-powered queries and FIRE planning.
          </p>
        </div>

        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <div
              key={f.title}
              className={`group relative rounded-2xl border ${f.border} bg-card p-7 card-hover gradient-border transition-all`}
              style={{ animationDelay: `${i * 0.07}s` }}
            >
              <div className={`mb-5 inline-flex h-11 w-11 items-center justify-center rounded-xl ${f.bg} border ${f.border} transition-transform group-hover:scale-110`}>
                <f.icon className={`h-5 w-5 ${f.color}`} />
              </div>
              <h3 className="mb-2.5 text-[15px] font-semibold text-foreground">{f.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── How it works ───────────────────────────────────────────────────── */}
      <section id="how-it-works" className="bg-muted/30 border-y border-border/50">
        <div className="mx-auto max-w-6xl px-5 py-24">
          <div className="text-center mb-16">
            <p className="text-xs font-semibold uppercase tracking-widest text-primary mb-3 opacity-70">How it works</p>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground">
              Up and running in minutes
            </h2>
            <p className="mt-4 text-lg text-muted-foreground max-w-xl mx-auto leading-relaxed">
              From sign-up to asking your AI about your spending in three simple steps.
            </p>
          </div>

          <div className="grid gap-6 sm:grid-cols-3 relative">
            {/* Connector lines (desktop only) */}
            <div className="hidden sm:block absolute top-14 left-1/3 right-1/3 h-px bg-gradient-to-r from-border/0 via-border to-border/0" />

            {HOW_IT_WORKS.map((step, i) => (
              <div key={step.step} className="relative rounded-2xl border border-border/60 bg-card p-8 text-center card-hover">
                <div className="mb-1 text-[11px] font-bold uppercase tracking-widest text-muted-foreground/40">Step {step.step}</div>
                <div className={`mx-auto mb-5 mt-4 flex h-14 w-14 items-center justify-center rounded-2xl ${step.bg}`}>
                  <step.icon className={`h-6 w-6 ${step.color}`} />
                </div>
                <h3 className="mb-3 text-base font-semibold text-foreground">{step.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── MCP Differentiator ─────────────────────────────────────────────── */}
      <section id="mcp" className="mx-auto max-w-6xl px-5 py-24">
        <div className="rounded-3xl border border-primary/20 bg-gradient-to-br from-primary/5 via-violet-500/3 to-background p-10 sm:p-16 relative overflow-hidden">
          <div className="pointer-events-none absolute -top-24 -right-24 h-72 w-72 rounded-full bg-violet-500/8 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-16 -left-16 h-56 w-56 rounded-full bg-indigo-500/8 blur-3xl" />

          <div className="relative grid gap-12 lg:grid-cols-2 items-center">
            {/* Left copy */}
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/8 px-3 py-1 mb-6 text-xs font-medium text-primary">
                <Zap className="h-3 w-3" />
                MCP Server included
              </div>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground mb-5 leading-tight">
                Your AI assistant
                <br />
                <span className="text-gradient">meets your finances</span>
              </h2>
              <p className="text-muted-foreground leading-relaxed mb-8 text-[15px]">
                Finlynq ships with a built-in MCP server exposing 27 financial tools.
                Connect Claude Desktop, Cursor, or any MCP-compatible client and start
                asking questions in plain English — no custom code, no exports.
              </p>

              <div className="space-y-3 mb-8">
                {[
                  "27 read + write tools",
                  "Streamable HTTP + stdio transports",
                  "Works with Claude, Cursor, Windsurf, Cline, and more",
                  "Responds with charts & structured data",
                ].map((item) => (
                  <div key={item} className="flex items-center gap-2.5 text-sm text-muted-foreground">
                    <Check className="h-4 w-4 text-emerald-500 shrink-0" />
                    {item}
                  </div>
                ))}
              </div>

              <div className="flex flex-col sm:flex-row gap-3">
                <Link
                  href="/cloud?tab=register"
                  className="inline-flex items-center gap-2 justify-center rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/25 hover:bg-primary/90 hover:scale-[1.02] active:scale-[0.99] transition-all"
                >
                  Get Started <ArrowRight className="h-4 w-4" />
                </Link>
                <Link
                  href="/mcp-guide"
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-border px-6 py-3 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-border/80 hover:bg-muted/40 transition-all"
                >
                  View MCP Guide
                </Link>
              </div>
            </div>

            {/* Right: chat mockup */}
            <div className="space-y-3">
              {MCP_PROMPTS.map((item, i) => (
                <div
                  key={i}
                  className="rounded-xl border border-border/50 bg-card/80 backdrop-blur-sm overflow-hidden"
                >
                  <div className="flex items-start gap-3 px-4 py-3 border-b border-border/30">
                    <Bot className="h-4 w-4 text-violet-500 mt-0.5 shrink-0" />
                    <span className="text-sm text-foreground">{item.q}</span>
                  </div>
                  <div className="flex items-center gap-3 px-4 py-2.5 bg-muted/30">
                    <Sparkles className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                    <span className="text-xs text-muted-foreground font-mono">{item.a}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── Privacy & Security ─────────────────────────────────────────────── */}
      <section id="security" className="bg-muted/30 border-y border-border/50">
        <div className="mx-auto max-w-6xl px-5 py-24">
          <div className="text-center mb-16">
            <p className="text-xs font-semibold uppercase tracking-widest text-primary mb-3 opacity-70">Privacy First</p>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground leading-tight">
              Bank-grade encryption. Zero-knowledge.{" "}
              <span className="text-gradient">Truly private.</span>
            </h2>
            <p className="mt-4 text-lg text-muted-foreground max-w-xl mx-auto leading-relaxed">
              Your financial data is encrypted with your password before it ever touches our servers.
              We designed the system so we mathematically cannot read it.
            </p>
          </div>

          {/* Encryption flow diagram */}
          <div className="flex flex-wrap items-center justify-center gap-3 mb-14 text-sm font-medium">
            {[
              { icon: Key, label: "Your Password", color: "text-indigo-500", bg: "bg-indigo-50 dark:bg-indigo-500/10 border-indigo-100 dark:border-indigo-500/20" },
              { icon: null, label: "→", color: "text-muted-foreground/40", bg: "" },
              { icon: Lock, label: "Derive Key", color: "text-violet-500", bg: "bg-violet-50 dark:bg-violet-500/10 border-violet-100 dark:border-violet-500/20" },
              { icon: null, label: "→", color: "text-muted-foreground/40", bg: "" },
              { icon: Shield, label: "AES-256 Encrypt", color: "text-emerald-500", bg: "bg-emerald-50 dark:bg-emerald-500/10 border-emerald-100 dark:border-emerald-500/20" },
              { icon: null, label: "→", color: "text-muted-foreground/40", bg: "" },
              { icon: EyeOff, label: "Stored Encrypted", color: "text-rose-500", bg: "bg-rose-50 dark:bg-rose-500/10 border-rose-100 dark:border-rose-500/20" },
            ].map((item, i) =>
              item.icon ? (
                <div key={i} className={`flex items-center gap-2 rounded-xl border px-4 py-2.5 ${item.bg}`}>
                  <item.icon className={`h-4 w-4 ${item.color}`} />
                  <span className={`text-sm font-medium ${item.color}`}>{item.label}</span>
                </div>
              ) : (
                <span key={i} className={`text-xl font-light ${item.color}`}>{item.label}</span>
              )
            )}
          </div>

          {/* Feature cards */}
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-4">
            {/* AES-256 */}
            <div className="group relative rounded-2xl border border-indigo-100 dark:border-indigo-500/20 bg-card p-7 card-hover gradient-border transition-all">
              <div className="mb-5 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-50 dark:bg-indigo-500/10 border border-indigo-100 dark:border-indigo-500/20 transition-transform group-hover:scale-110">
                <Shield className="h-5 w-5 text-indigo-500" />
              </div>
              <h3 className="mb-2.5 text-[15px] font-semibold text-foreground">AES-256 Encryption</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                The same standard used by banks and governments. All your financial data is encrypted
                before it touches any storage — in transit and at rest.
              </p>
            </div>

            {/* Your password is the key */}
            <div className="group relative rounded-2xl border border-violet-100 dark:border-violet-500/20 bg-card p-7 card-hover gradient-border transition-all">
              <div className="mb-5 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-violet-50 dark:bg-violet-500/10 border border-violet-100 dark:border-violet-500/20 transition-transform group-hover:scale-110">
                <Key className="h-5 w-5 text-violet-500" />
              </div>
              <h3 className="mb-2.5 text-[15px] font-semibold text-foreground">Your Password Is The Key</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Your encryption key is derived from your password using PBKDF2. Finlynq never sees
                your passphrase or your plaintext data — not even in memory on our servers.
              </p>
            </div>

            {/* Zero-knowledge */}
            <div className="group relative rounded-2xl border border-emerald-100 dark:border-emerald-500/20 bg-card p-7 card-hover gradient-border transition-all">
              <div className="mb-5 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-100 dark:border-emerald-500/20 transition-transform group-hover:scale-110">
                <EyeOff className="h-5 w-5 text-emerald-500" />
              </div>
              <h3 className="mb-2.5 text-[15px] font-semibold text-foreground">Zero-Knowledge Architecture</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                We designed the system so we <em>cannot</em> see your transactions, balances, or accounts.
                It&apos;s mathematically impossible for Finlynq to read your data without your password.
              </p>
            </div>

            {/* Open source / self-host */}
            <div className="group relative rounded-2xl border border-cyan-100 dark:border-cyan-500/20 bg-card p-7 card-hover gradient-border transition-all">
              <div className="mb-5 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-cyan-50 dark:bg-cyan-500/10 border border-cyan-100 dark:border-cyan-500/20 transition-transform group-hover:scale-110">
                <Globe className="h-5 w-5 text-cyan-500" />
              </div>
              <h3 className="mb-2.5 text-[15px] font-semibold text-foreground">Self-Host for Free</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Don&apos;t trust the cloud? Run the entire app on your own server or local machine.
                Your data never leaves your hardware. Free forever with full feature access.
              </p>
            </div>
          </div>

          {/* Warning box */}
          <div className="mt-8 rounded-2xl border border-amber-300/60 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/8 p-6 sm:p-8 flex flex-col sm:flex-row gap-5 items-start">
            <div className="shrink-0 flex h-11 w-11 items-center justify-center rounded-xl bg-amber-100 dark:bg-amber-500/20 border border-amber-200 dark:border-amber-500/30">
              <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            </div>
            <div className="space-y-2">
              <h3 className="text-[15px] font-semibold text-amber-900 dark:text-amber-300">
                Password Recovery Is Impossible — By Design
              </h3>
              <p className="text-sm text-amber-800/80 dark:text-amber-400/80 leading-relaxed">
                Because only you hold the encryption key, if you lose your password your data is
                permanently inaccessible. Even Finlynq cannot recover it. This is a feature, not a bug —
                it&apos;s what makes your data truly private.{" "}
                <strong className="font-semibold text-amber-900 dark:text-amber-300">
                  Write your password down and store it somewhere safe.
                </strong>
              </p>
              <p className="text-sm text-amber-700/70 dark:text-amber-400/70 leading-relaxed">
                <strong className="font-medium text-amber-900 dark:text-amber-300">Your escape hatch:</strong>{" "}
                You can always download a full backup of your data from Settings → Privacy &amp; Backup.
                If you ever lose your password, reset your account and restore from your backup file —
                you never permanently lose your data as long as you have a backup.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Trust indicators ───────────────────────────────────────────────── */}
      <section className="border-y border-border/50 bg-muted/20">
        <div className="mx-auto max-w-5xl px-5 py-8">
          <div className="flex flex-wrap items-center justify-center gap-8 sm:gap-12">
            {TRUST.map((t) => (
              <div key={t.label} className="flex items-center gap-2.5 text-sm text-muted-foreground">
                <t.icon className="h-4 w-4 text-primary/60" />
                {t.label}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Pricing ────────────────────────────────────────────────────────── */}
      <section id="pricing" className="mx-auto max-w-6xl px-5 py-24">
        <div className="text-center mb-16">
          <p className="text-xs font-semibold uppercase tracking-widest text-primary mb-3 opacity-70">Pricing</p>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground">
            Simple, transparent pricing
          </h2>
          <p className="mt-4 text-lg text-muted-foreground max-w-xl mx-auto leading-relaxed">
            Start free. Self-host forever. Or let us handle the infrastructure.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-3 items-start">
          {PRICING.map((plan) => (
            <div
              key={plan.name}
              className={`relative rounded-2xl border p-8 flex flex-col transition-all ${
                plan.featured
                  ? "border-primary/40 bg-gradient-to-b from-primary/8 to-card shadow-xl shadow-primary/8 scale-[1.02] lg:scale-105"
                  : "border-border/60 bg-card card-hover"
              }`}
            >
              {plan.featured && (
                <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
                  <span className="rounded-full bg-primary px-4 py-1 text-[11px] font-bold text-primary-foreground shadow-md tracking-wide uppercase">
                    Most Popular
                  </span>
                </div>
              )}

              <div className="mb-7">
                <h3 className="text-base font-semibold text-foreground mb-1">{plan.name}</h3>
                <div className="flex items-baseline gap-1 mb-2">
                  <span className="text-4xl font-extrabold tracking-tight text-foreground hero-number">{plan.price}</span>
                  <span className="text-sm text-muted-foreground">{plan.period}</span>
                </div>
                <p className="text-sm text-muted-foreground">{plan.desc}</p>
              </div>

              <ul className="space-y-3 mb-8 flex-1">
                {plan.features.map((feat) => (
                  <li key={feat} className="flex items-start gap-2.5 text-sm">
                    <Check className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
                    <span className="text-muted-foreground">{feat}</span>
                  </li>
                ))}
              </ul>

              <Link
                href={plan.href}
                className={`rounded-xl px-6 py-3 text-sm font-semibold text-center transition-all hover:scale-[1.02] active:scale-[0.99] ${
                  plan.featured
                    ? "bg-primary text-primary-foreground shadow-lg shadow-primary/25 hover:bg-primary/90"
                    : "border border-border/80 text-foreground hover:bg-muted/50 hover:border-border"
                }`}
              >
                {plan.cta}
              </Link>
            </div>
          ))}
        </div>
      </section>

      {/* ── Final CTA ──────────────────────────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-5 pb-24">
        <div className="rounded-3xl border border-border/60 bg-gradient-to-br from-primary/8 via-card to-card p-12 sm:p-16 text-center relative overflow-hidden">
          <div className="pointer-events-none absolute inset-0 bg-dot-pattern opacity-40" />
          <div className="pointer-events-none absolute -top-16 left-1/2 -translate-x-1/2 h-48 w-96 rounded-full bg-primary/8 blur-3xl" />

          <div className="relative">
            <div className="mb-5 flex justify-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 via-violet-500 to-purple-600 shadow-xl shadow-indigo-500/25">
                <Target className="h-7 w-7 text-white" />
              </div>
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground mb-4 leading-tight">
              Start understanding your finances today
            </h2>
            <p className="text-lg text-muted-foreground max-w-lg mx-auto mb-10 leading-relaxed">
              Join the first personal finance app built for AI assistants.
              Cloud or self-hosted — your data, your rules.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Link
                href="/cloud?tab=register"
                className="flex items-center gap-2 justify-center rounded-xl bg-primary px-8 py-3.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/25 hover:bg-primary/90 hover:scale-[1.02] active:scale-[0.99] transition-all w-full sm:w-auto"
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

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <footer className="border-t border-border/50 bg-muted/20">
        <div className="mx-auto max-w-6xl px-5 py-14">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-10 mb-12">
            {/* Brand */}
            <div className="col-span-2">
              <Link href="/" className="flex items-center gap-2.5 mb-4 group w-fit">
                <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 via-violet-500 to-purple-600">
                  <span className="text-xs font-bold text-white">FL</span>
                </div>
                <span className="text-sm font-semibold tracking-tight">Finlynq</span>
              </Link>
              <p className="text-sm text-muted-foreground leading-relaxed max-w-[220px]">
                The personal finance app built for the AI era.
              </p>
            </div>

            {/* Link columns */}
            {Object.entries(FOOTER_LINKS).map(([title, links]) => (
              <div key={title}>
                <h4 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground/60 mb-4">{title}</h4>
                <ul className="space-y-2.5">
                  {links.map((link) => (
                    <li key={link.label}>
                      <Link
                        href={link.href}
                        className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          {/* Bottom bar */}
          <div className="border-t border-border/50 pt-8 flex flex-col sm:flex-row items-center justify-between gap-4">
            <p className="text-xs text-muted-foreground/50">
              &copy; {new Date().getFullYear()} Finlynq. All rights reserved.
            </p>
            <div className="flex items-center gap-5 text-xs text-muted-foreground/50">
              <span>AES-256 Encrypted</span>
              <span>·</span>
              <span>Local-first</span>
              <span>·</span>
              <span>MCP-powered</span>
            </div>
          </div>
        </div>
      </footer>

    </div>
  );
}
