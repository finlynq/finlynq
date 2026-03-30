import Link from "next/link";

export default function LandingPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-dot-pattern ambient-glow">
      <div className="mx-auto w-full max-w-lg px-6 py-12 text-center">
        {/* Logo */}
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary">
          <span className="text-2xl font-extrabold tracking-wide text-primary-foreground">
            PF
          </span>
        </div>

        <h1 className="mb-2 text-3xl font-bold tracking-tight text-foreground">
          Welcome to PF
        </h1>
        <p className="mb-10 text-muted-foreground">
          Choose how you want to manage your finances
        </p>

        <div className="grid gap-4">
          {/* Self-Hosted Card */}
          <Link
            href="/dashboard"
            className="group flex items-center gap-4 rounded-xl border border-border bg-card p-5 text-left transition-colors hover:border-primary/50 hover:bg-accent"
          >
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-secondary text-2xl">
              🔒
            </div>
            <div>
              <h2 className="text-base font-semibold text-foreground group-hover:text-primary">
                Self-Hosted
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Your data stays on your device. Secured with a passphrase. No
                account needed.
              </p>
            </div>
          </Link>

          {/* Cloud / Managed Card */}
          <a
            href="https://app.finance.nextsoftwareconsulting.com"
            className="group flex items-center gap-4 rounded-xl border border-border bg-card p-5 text-left transition-colors hover:border-primary/50 hover:bg-accent"
          >
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-secondary text-2xl">
              ☁️
            </div>
            <div>
              <h2 className="text-base font-semibold text-foreground group-hover:text-primary">
                Cloud
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Sign in with your account. Access your data from any device.
                Synced and backed up.
              </p>
            </div>
          </a>
        </div>

        <p className="mt-8 text-xs text-muted-foreground/60">
          PF &mdash; Track your money here, analyze it anywhere
        </p>
      </div>
    </div>
  );
}
