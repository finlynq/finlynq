"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { AnalyticsConsent } from "@/components/analytics-consent";
import { LogoMark } from "@/components/logo-mark";
import { StoreBadges } from "@/components/store-badges";

const FEATURES = [
  {
    idx: "F.01 · AI NATIVE",
    title: "Talk to your money in plain English.",
    desc: "Connect Claude, Cursor, or any MCP client. Or just use the in-app AI chat, no setup at all. That's 109 HTTP / 93 stdio tools. Ask a question, get charts and real answers back. No custom exports, no BI tool.",
    viz: "bars",
  },
  {
    idx: "F.02 · IMPORT",
    title: "Connect a bank, or drop a file.",
    desc: "Link your bank so transactions flow in automatically, or import CSV, Excel, OFX, QFX, and PDF. Finlynq remembers how you mapped the columns and saves it as a template, so the next import is one click.",
    viz: "import",
  },
  {
    idx: "F.03 · BUDGETS",
    title: "Envelope budgeting, rolled over.",
    desc: "Month-by-month envelopes that roll over. Know exactly what's left in Groceries, Dining, or Travel before you swipe.",
    viz: "budgets",
  },
  {
    idx: "F.04 · PORTFOLIO",
    title: "Holdings, returns, benchmarks.",
    desc: "Live prices, XIRR, benchmarks vs SPX/QQQ/VTI, lot-tracked cost basis with FX-aware realized gains, and RRSP/TFSA/RESP contribution-room tracking. Built for people who actually track their money, not just watch it.",
    viz: "portfolio",
  },
  {
    idx: "F.05 · FIRE",
    title: "Project your freedom number.",
    desc: "Monte Carlo simulations, savings-rate scenarios, and a realistic FIRE target. See when you can stop, and what would actually move the date.",
    viz: "fire",
  },
  {
    idx: "F.06 · PRIVACY",
    title: "Self-host. Or don't.",
    desc: "Run it on your Mac, your homelab, or our cloud. Same features either way. Per-user envelope encryption (AES-256-GCM, scrypt-derived key), and your DEK only lives in memory while you're signed in.",
    viz: "pips",
  },
] as const;

const STEPS = [
  {
    n: "01",
    title: "Bring in your transactions.",
    desc: "Connect your bank so transactions flow in automatically, or upload a CSV or OFX. Finlynq remembers your columns, so every import after the first is one click.",
  },
  {
    n: "02",
    title: "Connect your AI.",
    desc: "Add Finlynq as an MCP server in Claude Desktop, Cursor, or any compatible client. Takes under 60 seconds.",
  },
  {
    n: "03",
    title: "Ask anything.",
    desc: "\"Am I on track with my budget?\" \"What's my net worth?\" \"Any unusual charges?\" Just ask.",
  },
];

const MCP_TOOLS = [
  { t: "Read-only balance & transaction queries", a: "READ" },
  { t: "Budget creation, editing, and rollover", a: "WRITE" },
  { t: "Portfolio holdings with live pricing", a: "READ" },
  { t: "Transaction categorization rules", a: "WRITE" },
  { t: "Anomaly & duplicate detection", a: "READ" },
  { t: "Goal tracking and projections", a: "READ" },
  { t: "Streamable HTTP + stdio transports", a: "PROTO" },
  { t: "Responds with charts & structured data", a: "FMT" },
];

const PLAN_FEATS = [
  "109 MCP tools (HTTP) · 93 (stdio), read & write",
  "Per-user AES-256-GCM envelope encryption · operator can't decrypt",
  "In-app AI chat, no MCP client setup required",
  "Native iOS and Android apps, available now",
  "Direct bank connections, plus CSV, Excel, OFX/QFX, PDF, email import",
  "RRSP, TFSA, RESP contribution-room tracking (CRA limits)",
  "Lot-tracked portfolio cost basis · dividends · FX-aware",
  "Cash-flow forecasting · spending anomaly detection",
  "Rules engine · budgets · goals · loans · subscriptions",
  "Self-host or managed cloud, same features either way",
  "REST API + MCP (HTTP & stdio · OAuth 2.1 + DCR)",
];

const ROADMAP_POINTS = [
  {
    label: "Live now",
    desc: "Encrypted finances, a built-in MCP server for any AI, native iOS and Android apps, direct bank connections, multi-currency portfolios, budgets, and imports.",
  },
  {
    label: "Building",
    desc: "Automatic brokerage connections, and an in-app AI assistant.",
  },
  {
    label: "Up next",
    desc: "Receipt OCR, smarter categorization, deeper budgeting and investing, debt payoff, retirement planning, tax tools, and custom dashboards.",
  },
  {
    label: "Exploring",
    desc: "Full retirement planning, notifications, freelancer tools, and household sharing.",
  },
] as const;

const ROADMAP_LEDE =
  "What's live, what we're building, and what's coming. This is a direction, not a promise. Finlynq is open source, after all.";

function FeatureViz({ kind }: { kind: (typeof FEATURES)[number]["viz"] }) {
  switch (kind) {
    case "bars":
      // Bar heights pulled into landing.css classes (.bars i.hNN) to keep
      // CSP style-src free of 'unsafe-inline' (FINLYNQ-83).
      return (
        <div className="viz bars">
          <i className="h22" />
          <i className="h38" />
          <i className="h30" />
          <i className="h58" />
          <i className="h44" />
          <i className="hl h70" />
          <i className="h60" />
          <i className="hl h82" />
          <i className="h50" />
          <i className="hl h76" />
          <i className="hl h90" />
        </div>
      );
    case "import":
      return (
        <div className="viz">
          <svg viewBox="0 0 200 56" width="100%" height="100%" preserveAspectRatio="none">
            <g fontFamily="var(--fl-mono)" fontSize="9" fill="#6b737d">
              <text x="0" y="12">chase.csv</text>
              <text x="0" y="30">amex.ofx</text>
              <text x="0" y="48">vanguard.qfx</text>
            </g>
            <g stroke="#2a3139" strokeWidth="1">
              <line x1="70" y1="9" x2="120" y2="9" />
              <line x1="70" y1="27" x2="120" y2="27" />
              <line x1="78" y1="45" x2="120" y2="45" />
            </g>
            <g fill="#f5a623" fontFamily="var(--fl-mono)" fontSize="9">
              <text x="124" y="12">✓ mapped</text>
              <text x="124" y="30">✓ mapped</text>
              <text x="124" y="48">✓ mapped</text>
            </g>
          </svg>
        </div>
      );
    case "budgets":
      return (
        <div className="viz">
          <svg viewBox="0 0 200 56" width="100%" height="100%" preserveAspectRatio="none">
            <g fontFamily="var(--fl-mono)" fontSize="9">
              <text x="0" y="10" fill="#9aa3ad">GROCERIES</text>
              <text x="200" y="10" textAnchor="end" fill="#e8eaed">$412 / $600</text>
              <text x="0" y="34" fill="#9aa3ad">DINING</text>
              <text x="200" y="34" textAnchor="end" fill="#e8eaed">$188 / $250</text>
            </g>
            <rect x="0" y="14" width="200" height="4" fill="#1e242b" />
            <rect x="0" y="14" width="138" height="4" fill="#f5a623" />
            <rect x="0" y="38" width="200" height="4" fill="#1e242b" />
            <rect x="0" y="38" width="152" height="4" fill="#5ac8a8" />
          </svg>
        </div>
      );
    case "portfolio":
      return (
        <div className="viz">
          <svg viewBox="0 0 200 56" width="100%" height="100%" preserveAspectRatio="none">
            <polyline
              points="0,40 20,36 40,30 60,32 80,22 100,24 120,16 140,14 160,10 180,6 200,4"
              fill="none"
              stroke="#f5a623"
              strokeWidth="1.5"
            />
            <polyline
              points="0,44 20,42 40,40 60,38 80,36 100,34 120,32 140,30 160,28 180,26 200,24"
              fill="none"
              stroke="#6b737d"
              strokeWidth="1"
              strokeDasharray="2 3"
            />
            <g fontFamily="var(--fl-mono)" fontSize="9" fill="#9aa3ad">
              <text x="0" y="56">XIRR</text>
              <text x="200" y="56" textAnchor="end" fill="#5ac8a8">+14.2%</text>
            </g>
          </svg>
        </div>
      );
    case "fire":
      return (
        <div className="viz">
          <svg viewBox="0 0 200 56" width="100%" height="100%" preserveAspectRatio="none">
            <g strokeWidth="1" fill="none">
              <path d="M0,40 C40,35 80,25 120,18 S160,12 200,8" stroke="#2a3139" />
              <path d="M0,44 C40,40 80,32 120,24 S160,18 200,14" stroke="#2a3139" />
              <path d="M0,48 C40,45 80,40 120,32 S160,26 200,20" stroke="#2a3139" />
              <path d="M0,42 C40,36 80,26 120,18 S160,12 200,6" stroke="#f5a623" strokeWidth="1.8" />
            </g>
            <circle cx="200" cy="6" r="3" fill="#f5a623" />
            <g fontFamily="var(--fl-mono)" fontSize="9" fill="#9aa3ad">
              <text x="0" y="56">FI YEAR</text>
              <text x="200" y="56" textAnchor="end" fill="#f5a623">2034</text>
            </g>
          </svg>
        </div>
      );
    case "pips":
      return (
        <div className="viz pips">
          <span>DOCKER</span>·<b>00.02.14</b>·<span>AES-256-GCM</span>·<b>✓</b>·<span>POSTGRES</span>
        </div>
      );
  }
}

export function LandingClient() {
  const heroChartRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -10% 0px" }
    );
    document.querySelectorAll(".fl-landing .reveal").forEach((el) => io.observe(el));

    const hc = heroChartRef.current;
    if (hc) {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => hc.classList.add("in"))
      );
    }

    return () => io.disconnect();
  }, []);

  return (
    <div className="fl-landing">
      <AnalyticsConsent />
      {/* NAV */}
      <header className="fl-nav">
        <div className="fl-container nav-inner">
          <Link href="/" className="fl-logo" aria-label="Finlynq home">
            <LogoMark />
            Finlynq
          </Link>
          <nav className="nav-links" aria-label="Primary">
            <a href="#features">Features</a>
            <a href="#flow">How it works</a>
            <a href="#mcp">MCP</a>
            <a href="#privacy">Privacy</a>
            <a href="#roadmap">Roadmap</a>
            <a href="#pricing">Pricing</a>
            <Link href="/vs">Compare</Link>
            <Link href="/mcp-guide">MCP guide</Link>
          </nav>
          <div className="nav-cta">
            <Link href="/cloud" className="btn btn-ghost">Log in</Link>
            <Link href="/cloud?tab=register" className="btn btn-primary">
              Sign up <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>
      </header>

      {/* HERO */}
      <section className="hero">
        <div className="fl-container hero-grid">
          <div className="hero-copy reveal">
            <div className="hero-bar">
              <span className="tag">MCP</span>
              <span>109 HTTP / 93 stdio tools · Claude · ChatGPT · Cursor · Windsurf · Cline</span>
            </div>

            <Link href="/blog/finlynq-mobile-app" className="hero-bar hero-bar-mobile hero-bar-link">
              <span className="tag">MOBILE</span>
              <span>Now on iOS and Android <span aria-hidden="true">→</span></span>
            </Link>

            <h1 className="display-xl">
              Your money,<br />
              <em>understood</em> by<br />
              any AI you choose.
            </h1>

            <p className="lede lede-mt-28">
              Encrypted, private, and yours. Connect your bank, add Claude or Cursor, and
              ask about your finances in plain English.
            </p>

            <p className="lede lede-tagline">
              Use our free hosted cloud, or self-host with Docker. Same features either way.
            </p>

            <div className="hero-cta">
              <Link href="/cloud?tab=register" className="btn btn-primary">
                Try the hosted cloud <span aria-hidden="true">→</span>
              </Link>
              <Link href="/try-demo?next=/dashboard" prefetch={false} className="btn btn-ghost">
                Try the demo (1 click)
              </Link>
              <Link href="/self-hosted" className="btn btn-ghost">
                Self-host with Docker
              </Link>
            </div>

            <StoreBadges className="mt-7" />

            <div className="hero-meta">
              <div className="cell">
                <div className="v num">109</div>
                <div className="k">MCP tools (HTTP)</div>
              </div>
              <div className="cell">
                <div className="v num">AES-256-GCM</div>
                <div className="k">Encryption</div>
              </div>
              <div className="cell">
                <div className="v num">6</div>
                <div className="k">Import formats</div>
              </div>
              <div className="cell">
                <div className="v num">100%</div>
                <div className="k">Open source</div>
              </div>
            </div>
          </div>

          {/* Hero chart card */}
          <div className="chart-card reveal d2" ref={heroChartRef}>
            <div className="ticker" aria-hidden="true">
              <div className="ticker-track">
                {Array.from({ length: 2 }).flatMap((_, i) => [
                  <span key={`n-${i}`}>
                    NET WORTH <span className="num">$84,210</span>{" "}
                    <span className="up">▲ 1.48%</span>
                  </span>,
                  <span key={`p-${i}`}>
                    PORTFOLIO <span className="num">$42,118</span>{" "}
                    <span className="up">▲ 0.62%</span>
                  </span>,
                  <span key={`s-${i}`}>
                    SPEND MTD <span className="num">$2,184</span>{" "}
                    <span className="down">▼ 12.4%</span>
                  </span>,
                  <span key={`r-${i}`}>
                    SAVINGS RATE <span className="num">28.4%</span>{" "}
                    <span className="up">▲ 3.1%</span>
                  </span>,
                  <span key={`f-${i}`}>
                    FIRE TARGET <span className="num">2034</span>
                  </span>,
                ])}
              </div>
            </div>

            <div className="chart-head chart-head-mt-28">
              <div>
                <div className="chart-title">Net worth · Last 12 months</div>
                <div className="chart-val num">
                  $84,210<span className="dim">.48</span>
                </div>
                <div className="chart-delta">
                  <span>▲</span> <span className="num">+$12,460 · +17.4%</span>
                </div>
              </div>
              <div className="chart-controls" role="tablist">
                <span>1M</span>
                <span>3M</span>
                <span>6M</span>
                <span className="active">1Y</span>
                <span>ALL</span>
              </div>
            </div>

            <svg className="chart-svg" viewBox="0 0 520 220" preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <linearGradient id="flGArea" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f5a623" stopOpacity="0.28" />
                  <stop offset="100%" stopColor="#f5a623" stopOpacity="0" />
                </linearGradient>
                <pattern id="flGridPat" x="0" y="0" width="52" height="44" patternUnits="userSpaceOnUse">
                  <path d="M 52 0 L 0 0 0 44" fill="none" stroke="#1e242b" strokeWidth="1" />
                </pattern>
              </defs>
              <rect width="520" height="220" fill="url(#flGridPat)" />

              <g fontFamily="var(--fl-mono)" fontSize="9" fill="#6b737d" textAnchor="end">
                <text x="516" y="18">$90k</text>
                <text x="516" y="62">$75k</text>
                <text x="516" y="106">$60k</text>
                <text x="516" y="150">$45k</text>
                <text x="516" y="194">$30k</text>
              </g>

              <path
                className="chart-area"
                d="M0,168 L40,155 L75,162 L112,140 L148,130 L185,112 L220,118 L258,95 L295,88 L330,76 L365,80 L398,58 L432,48 L465,40 L495,30 L495,220 L0,220 Z"
                fill="url(#flGArea)"
              />
              <path
                className="chart-line"
                d="M0,168 L40,155 L75,162 L112,140 L148,130 L185,112 L220,118 L258,95 L295,88 L330,76 L365,80 L398,58 L432,48 L465,40 L495,30"
                fill="none"
                stroke="#f5a623"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />

              <circle cx="495" cy="30" r="4" fill="#f5a623" />
              <circle cx="495" cy="30" r="9" fill="none" stroke="#f5a623" strokeOpacity=".25" strokeWidth="2">
                <animate attributeName="r" values="4;14;4" dur="2.6s" repeatCount="indefinite" />
                <animate attributeName="stroke-opacity" values=".4;0;.4" dur="2.6s" repeatCount="indefinite" />
              </circle>

              <g fontFamily="var(--fl-mono)" fontSize="10" fill="#9aa3ad">
                <line x1="295" y1="88" x2="295" y2="40" stroke="#2a3139" strokeDasharray="2 3" />
                <text x="298" y="34">Paycheck · +$4,820</text>
              </g>
            </svg>

            <div className="chart-foot">
              <div>
                <div className="k">Cash</div>
                <div className="v num">$18,402</div>
              </div>
              <div>
                <div className="k">Investments</div>
                <div className="v num pos">$42,118</div>
              </div>
              <div>
                <div className="k">Liabilities</div>
                <div className="v num neg">−$3,690</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* FEATURES */}
      <section className="fl-section" id="features">
        <div className="fl-container">
          <div className="section-head">
            <div className="reveal">
              <div className="tag">Features</div>
              <h2 className="display-l">
                Everything you need to<br />
                <em>master</em> your finances.
              </h2>
            </div>
            <p className="lede reveal d2">
              The whole toolkit: budgets, portfolios, goals, loans, and AI-powered queries. No
              dashboards to babysit unless you actually want them.
            </p>
          </div>

          <div className="features">
            {FEATURES.map((f, i) => (
              <article key={f.idx} className={`feature reveal ${i === 1 || i === 4 ? "d1" : i === 2 || i === 5 ? "d2" : ""}`}>
                <div className="idx">{f.idx}</div>
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
                <FeatureViz kind={f.viz} />
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="fl-section" id="flow">
        <div className="fl-container">
          <div className="section-head">
            <div className="reveal">
              <div className="tag">How it works</div>
              <h2 className="display-l">
                Three steps from sign-up<br />
                to <em>asking</em> your AI.
              </h2>
            </div>
            <p className="lede reveal d2">
              From zero to &ldquo;how much did I spend on dining in Q3?&rdquo; in under five minutes. No
              configuration, no integration headaches.
            </p>
          </div>

          <div className="steps reveal">
            {STEPS.map((s) => (
              <div key={s.n} className="step">
                <div className="step-tag">Step {s.n}</div>
                <div className="step-n">{s.n}</div>
                <h4>{s.title}</h4>
                <p>{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* MCP */}
      <section className="fl-section" id="mcp">
        <div className="fl-container">
          <div className="section-head">
            <div className="reveal">
              <div className="tag">MCP Server · Included</div>
              <h2 className="display-l">
                Your assistant meets<br />
                your <em>finances</em>.
              </h2>
            </div>
            <p className="lede reveal d2">
              A built-in MCP server exposes 109 HTTP financial tools (93 over stdio) to any compatible client over OAuth 2.1 + DCR. No custom
              code, no brittle exports, no exporting to a spreadsheet then copying into a prompt.
            </p>
          </div>

          <div className="mcp-grid">
            <div className="query-demo reveal">
              <div className="query-head">
                <div className="dots">
                  <i />
                  <i />
                  <i />
                </div>
                <div>claude · finlynq-mcp · connected</div>
              </div>
              <div className="query-body">
                <div className="q-item">
                  <div className="q-ask">How much did I spend on groceries last month?</div>
                  <div className="q-ans">
                    <div className="text">
                      <span className="num">$312.40</span> <span className="mute">up</span>{" "}
                      <span className="pos">8%</span> <span className="mute">vs October</span>
                    </div>
                    <svg className="sparkline" viewBox="0 0 96 28" preserveAspectRatio="none">
                      <polyline
                        points="0,22 14,18 28,20 42,14 56,16 70,10 84,8 96,6"
                        fill="none"
                        stroke="#f5a623"
                        strokeWidth="1.5"
                      />
                    </svg>
                  </div>
                </div>
                <div className="q-item">
                  <div className="q-ask">Am I on track with my budgets this month?</div>
                  <div className="q-ans">
                    <div className="text">
                      <span className="num">3 of 8</span>{" "}
                      <span className="mute">categories within budget</span>
                    </div>
                    <svg className="sparkline" viewBox="0 0 96 28" preserveAspectRatio="none">
                      <g>
                        <rect x="2" y="8" width="8" height="16" fill="#5ac8a8" />
                        <rect x="14" y="12" width="8" height="12" fill="#5ac8a8" />
                        <rect x="26" y="4" width="8" height="20" fill="#5ac8a8" />
                        <rect x="38" y="2" width="8" height="22" fill="#e5624b" />
                        <rect x="50" y="6" width="8" height="18" fill="#e5624b" />
                        <rect x="62" y="10" width="8" height="14" fill="#e5624b" />
                        <rect x="74" y="4" width="8" height="20" fill="#e5624b" />
                        <rect x="86" y="8" width="8" height="16" fill="#e5624b" />
                      </g>
                    </svg>
                  </div>
                </div>
                <div className="q-item">
                  <div className="q-ask">What&apos;s my current net worth?</div>
                  <div className="q-ans">
                    <div className="text">
                      <span className="num">$84,210</span> <span className="mute">up</span>{" "}
                      <span className="pos">$1,240</span> <span className="mute">this month</span>
                    </div>
                    <svg className="sparkline" viewBox="0 0 96 28" preserveAspectRatio="none">
                      <polyline
                        points="0,20 14,18 28,16 42,15 56,11 70,9 84,6 96,3"
                        fill="none"
                        stroke="#f5a623"
                        strokeWidth="1.5"
                      />
                    </svg>
                  </div>
                </div>
                <div className="q-item">
                  <div className="q-ask">Show me any unusual transactions recently.</div>
                  <div className="q-ans">
                    <div className="text">
                      <span className="num">2 anomalies</span>{" "}
                      <span className="mute">in the last 30 days</span>
                    </div>
                    <svg className="sparkline" viewBox="0 0 96 28" preserveAspectRatio="none">
                      <polyline
                        points="0,18 12,16 24,17 36,15 48,6 60,15 72,16 84,4 96,15"
                        fill="none"
                        stroke="#e5624b"
                        strokeWidth="1.5"
                      />
                      <circle cx="48" cy="6" r="2" fill="#e5624b" />
                      <circle cx="84" cy="4" r="2" fill="#e5624b" />
                    </svg>
                  </div>
                </div>
              </div>
            </div>

            <div className="reveal d2">
              <ul className="mcp-list">
                {MCP_TOOLS.map((m, i) => (
                  <li key={m.t}>
                    <span className="n">{String(i + 1).padStart(2, "0")}</span>
                    <span className="t">{m.t}</span>
                    <span className="a">{m.a}</span>
                  </li>
                ))}
              </ul>
              <div className="mcp-cta-row">
                <Link href="/cloud?tab=register" className="btn btn-primary">
                  Get started
                </Link>
                <Link href="/try-demo?next=/dashboard" prefetch={false} className="btn btn-ghost">
                  Try the live demo (no signup) <span aria-hidden="true">→</span>
                </Link>
                <Link href="/mcp-guide" className="btn btn-ghost">
                  View MCP guide <span aria-hidden="true">→</span>
                </Link>
                <Link href="/mcp-guide/tools" className="btn btn-ghost">
                  Full tool catalog <span aria-hidden="true">→</span>
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* PRIVACY */}
      <section className="fl-section" id="privacy">
        <div className="fl-container">
          <div className="section-head">
            <div className="reveal">
              <div className="tag">Privacy First</div>
              <h2 className="display-l">
                Zero-knowledge.<br />
                <em>Mathematically</em> private.
              </h2>
            </div>
            <p className="lede reveal d2">
              Your financial data* is encrypted with your password before it ever touches a server.
              We built it so we can&apos;t read it. That&apos;s not a marketing claim, it&apos;s a math one.
            </p>
          </div>

          <div className="privacy-diagram reveal">
            {[
              { k: "Step 01", t: "Your password" },
              { k: "Step 02", t: "Derive key (scrypt)" },
              { k: "Step 03", t: "Wrap your DEK" },
              { k: "Step 04", t: "AES-256-GCM at rest" },
            ].map((node, i, arr) => (
              <div key={node.k} className="priv-node">
                <div className="k">{node.k}</div>
                <div className="t">{node.t}</div>
                {i < arr.length - 1 && <div className="arrow">→</div>}
              </div>
            ))}
          </div>

          <div className="privacy-grid">
            {[
              {
                h: "AES-256 encryption.",
                p: "The same standard banks and governments use. Everything is encrypted before it touches storage, in transit and at rest.",
              },
              {
                h: "Your password is the key.",
                p: "Your encryption key is derived from your password via memory-hard scrypt (PBKDF2 also wraps optional backup-export passphrases). Finlynq never sees your passphrase or your plaintext data*.",
              },
              {
                h: "Zero-knowledge architecture.",
                p: "We cannot see your transactions, balances, or accounts.* It is mathematically impossible to read your data without your password.",
              },
              {
                h: "Self-host free, forever.",
                p: "Don't trust the cloud? Run the entire app on your own hardware. Full feature parity, no license fees, no data ever leaves.",
              },
            ].map((tile, i) => (
              <div key={tile.h} className={`priv-tile reveal ${i === 1 ? "d1" : i === 2 ? "d2" : i === 3 ? "d3" : ""}`}>
                <h4>
                  <span className="ic">◆</span> {tile.h}
                </h4>
                <p>{tile.p}</p>
              </div>
            ))}
          </div>

          <p className="reveal privacy-disclaimer">
            <span className="asterisk">*</span> Numeric amounts, dates, and unique IDs are stored unencrypted because the database needs them to work (totals, sorting, joins, indexes). Everything else (merchant names, account names, payees, notes, tags, and categories) is encrypted with a key derived only from your password. Read the{" "}
            <Link href="/blog/how-finlynq-encrypts-your-money" className="amber-link">
              plain-English writeup
            </Link>
            {" "}or the{" "}
            <a
              href="https://github.com/finlynq/finlynq/blob/main/pf-app/docs/architecture/encryption.md"
              target="_blank"
              rel="noreferrer"
              className="amber-link"
            >
              full encryption design
            </a>
            .
          </p>
        </div>
      </section>

      {/* ROADMAP */}
      <section className="fl-section" id="roadmap">
        <div className="fl-container">
          <div className="section-head">
            <div className="reveal">
              <div className="tag">Roadmap</div>
              <h2 className="display-l">
                Where we&apos;re<br />
                <em>headed</em> next.
              </h2>
            </div>
            <p className="lede reveal d2">{ROADMAP_LEDE}</p>
          </div>

          <ol className="roadmap-timeline reveal">
            {ROADMAP_POINTS.map((p) => (
              <li key={p.label} className="rm-node">
                <span className="rm-dot" aria-hidden="true" />
                <div className="rm-label">{p.label}</div>
                <p className="rm-desc">{p.desc}</p>
              </li>
            ))}
          </ol>

          <div className="roadmap-cta reveal">
            <Link href="/roadmap" className="btn btn-ghost">
              See the full roadmap <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>
      </section>

      {/* PRICING */}
      <section className="fl-section" id="pricing">
        <div className="fl-container">
          <div className="section-head">
            <div className="reveal">
              <div className="tag">Pricing</div>
              <h2 className="display-l">
                <em>Free.</em> Every feature.<br />
                No paywalls. Ever.
              </h2>
            </div>
            <p className="lede reveal d2">
              Finlynq is open-source under AGPL v3. Self-hosted or cloud, you get the same app. If
              it&apos;s useful, consider sponsoring development.
            </p>
          </div>

          <div className="plan reveal">
            <div className="plan-head">
              <div>
                <div className="eyebrow">
                  <span className="dot" />
                  FREE FOREVER · ALL FEATURES
                </div>
                <div className="plan-head-title">
                  Everything, included.
                </div>
              </div>
              <div className="plan-price">
                $0<span className="u">/ MO</span>
              </div>
            </div>
            <ul className="plan-feats">
              {PLAN_FEATS.map((f) => (
                <li key={f}>
                  <span className="check">✓</span>
                  {f}
                </li>
              ))}
            </ul>
            <div className="plan-cta-row">
              <Link href="/cloud?tab=register" className="btn btn-primary">
                Get started free
              </Link>
              <Link href="/self-hosted" className="btn btn-ghost">
                Self-host guide <span aria-hidden="true">→</span>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="fl-cta">
        <div className="fl-container cta-grid">
          <div className="reveal">
            <div className="eyebrow cta-eyebrow-mb-24">
              <span className="dot" />
              START TODAY
            </div>
            <h2 className="display-xl cta-display-xl">
              Understand your<br />
              finances, <em>finally</em>.
            </h2>
            <div className="cta-actions">
              <Link href="/cloud?tab=register" className="btn btn-primary">
                Get started free <span aria-hidden="true">→</span>
              </Link>
              <Link href="/try-demo?next=/dashboard" prefetch={false} className="btn btn-ghost">
                Try the live demo (no signup)
              </Link>
              <a
                href="https://github.com/finlynq/finlynq"
                className="btn btn-ghost"
                target="_blank"
                rel="noreferrer"
              >
                View on GitHub
              </a>
            </div>
          </div>
          <div className="reveal d2">
            <div className="cta-facts">
              <div className="cta-fact">
                <div className="eyebrow">LICENSED</div>
                <div>AGPL v3, open source forever</div>
              </div>
              <div className="cta-fact">
                <div className="eyebrow">ENCRYPTED</div>
                <div>AES-256-GCM envelope encryption. Your DEK, never ours.</div>
              </div>
              <div className="cta-fact">
                <div className="eyebrow">PORTABLE</div>
                <div>Export your whole account as a backup anytime.</div>
              </div>
              <div className="cta-fact">
                <div className="eyebrow">NO LOCK-IN</div>
                <div>Self-host in Docker. Same app, same features.</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="fl-footer">
        <div className="fl-container">
          <div className="footer-grid">
            <div>
              <Link href="/" className="fl-logo footer-logo-link">
                <LogoMark />
                Finlynq
              </Link>
              <p className="footer-blurb">
                The personal finance app built for the AI era. Encrypted, private, and yours.
              </p>
            </div>
            <div>
              <h5>Product</h5>
              <ul>
                <li><Link href="/about">What is Finlynq?</Link></li>
                <li><a href="#features">Features</a></li>
                <li><a href="#flow">How it works</a></li>
                <li><Link href="/mcp-guide">MCP &amp; API guide</Link></li>
                <li><Link href="/roadmap">Roadmap</Link></li>
                <li><Link href="/releases">Releases</Link></li>
                <li><Link href="/glossary">Glossary</Link></li>
                <li><Link href="/blog">Blog</Link></li>
                <li>
                  <a href="https://github.com/finlynq/finlynq" target="_blank" rel="noreferrer">
                    GitHub
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <h5>Hosting</h5>
              <ul>
                <li><Link href="/cloud?tab=register">Cloud (free)</Link></li>
                <li><Link href="/self-hosted">Self-hosted</Link></li>
                <li>
                  <a href="https://github.com/finlynq/finlynq" target="_blank" rel="noreferrer">
                    Docker image
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <h5>Compare</h5>
              <ul>
                <li><Link href="/vs">All comparisons</Link></li>
                <li><Link href="/vs/monarch">Finlynq vs Monarch Money</Link></li>
                <li><Link href="/vs/ynab">Finlynq vs YNAB</Link></li>
                <li><Link href="/vs/era">Finlynq vs Era</Link></li>
                <li><Link href="/vs/firefly-iii">Finlynq vs Firefly III</Link></li>
                <li><Link href="/vs/actual">Finlynq vs Actual Budget</Link></li>
                <li><Link href="/vs/ghostfolio">Finlynq vs Ghostfolio</Link></li>
                <li><Link href="/vs/maybe">Finlynq vs Maybe / Sure</Link></li>
                <li><Link href="/vs/alderfi">Finlynq vs Alderfi</Link></li>
              </ul>
            </div>
            <div>
              <h5>Community</h5>
              <ul>
                <li>
                  <a href="https://github.com/sponsors/finlynq" target="_blank" rel="noreferrer">
                    GitHub Sponsors
                  </a>
                </li>
                <li>
                  <a href="https://ko-fi.com/finlynq" target="_blank" rel="noreferrer">
                    Ko-fi
                  </a>
                </li>
                <li>
                  <a href="https://github.com/finlynq/finlynq/discussions" target="_blank" rel="noreferrer">
                    Discussions
                  </a>
                </li>
                <li>
                  <Link href="/privacy">Privacy</Link>
                </li>
                <li>
                  <Link href="/terms">Terms</Link>
                </li>
              </ul>
            </div>
          </div>
          <div className="footer-meta">
            <div>© {new Date().getFullYear()} Finlynq · All rights reserved.</div>
            <div className="badges">
              <span>AGPL v3</span>
              <span>AES-256</span>
              <span>MCP-powered</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
