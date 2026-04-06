import Link from "next/link";

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-dot-pattern ambient-glow px-6 py-16">
      <div className="mx-auto w-full max-w-xl text-center">
        {/* Logo */}
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 via-violet-500 to-purple-600 shadow-xl shadow-indigo-500/30">
          <span className="text-2xl font-extrabold tracking-wide text-white">PF</span>
        </div>

        {/* Headline */}
        <h1 className="mb-3 text-4xl font-bold tracking-tight text-foreground">
          Track your money here,<br />
          <span className="bg-gradient-to-r from-indigo-400 to-violet-400 bg-clip-text text-transparent">
            analyze it anywhere.
          </span>
        </h1>
        <p className="mb-4 text-base text-muted-foreground max-w-md mx-auto leading-relaxed">
          The only personal finance app with a built-in MCP server. Ask your AI assistant about your spending, budgets, and investments — in plain English.
        </p>

        {/* Value props */}
        <div className="mb-8 flex flex-wrap justify-center gap-x-5 gap-y-1.5 text-sm text-muted-foreground">
          {[
            "Works with Claude & ChatGPT",
            "27 financial tools",
            "Your data stays private",
            "No bank sync required",
          ].map((v) => (
            <span key={v} className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-indigo-400 shrink-0" />
              {v}
            </span>
          ))}
        </div>

        {/* Demo video placeholder */}
        <div className="mb-8 overflow-hidden rounded-2xl border border-border/60 bg-card/60 shadow-xl shadow-black/10">
          <div className="flex aspect-video items-center justify-center bg-gradient-to-br from-indigo-950/40 to-violet-950/40">
            <div className="text-center">
              <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-white/10 backdrop-blur-sm border border-white/10">
                <svg className="h-6 w-6 text-white/80 ml-0.5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
              <p className="text-sm font-medium text-white/70">60-second demo</p>
              <p className="text-xs text-white/40">Coming soon</p>
            </div>
          </div>
        </div>

        {/* Primary CTA — Cloud */}
        <Link
          href="/cloud"
          className="group mb-4 flex w-full items-center justify-between rounded-2xl bg-gradient-to-r from-indigo-500 to-violet-600 px-6 py-5 text-left shadow-lg shadow-indigo-500/25 hover:shadow-indigo-500/40 hover:from-indigo-400 hover:to-violet-500 transition-all duration-200"
        >
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-base font-bold text-white">Start Free Trial</span>
              <span className="rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-semibold text-white/90 uppercase tracking-wide">
                14 days free
              </span>
            </div>
            <p className="text-sm text-white/70">
              Cloud-hosted · Works from any device · No setup required
            </p>
          </div>
          <svg className="h-5 w-5 text-white/80 shrink-0 transition-transform group-hover:translate-x-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
          </svg>
        </Link>

        {/* Secondary CTA — Self-hosted */}
        <Link
          href="/self-hosted"
          className="group flex w-full items-center justify-between rounded-xl border border-border/60 bg-card/60 px-5 py-4 text-left hover:border-border hover:bg-card transition-all duration-200"
        >
          <div>
            <span className="text-sm font-semibold text-foreground/80 group-hover:text-foreground">
              Self-Hosted
            </span>
            <p className="text-xs text-muted-foreground mt-0.5">
              SQLite + SQLCipher · Your device · Free forever
            </p>
          </div>
          <svg className="h-4 w-4 text-muted-foreground shrink-0 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
          </svg>
        </Link>

        <p className="mt-8 text-xs text-muted-foreground/50">
          PF &mdash; Track your money here, analyze it anywhere
        </p>
      </div>
    </div>
  );
}
