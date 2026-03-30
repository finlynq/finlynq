import Link from "next/link";

export default function SelfHostedPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-dot-pattern ambient-glow">
      <div className="mx-auto w-full max-w-lg px-6 py-12">
        {/* Back link */}
        <Link
          href="/"
          className="mb-8 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          ← Back
        </Link>

        {/* Logo */}
        <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary">
          <span className="text-2xl font-extrabold tracking-wide text-primary-foreground">
            PF
          </span>
        </div>

        <h1 className="mb-2 text-3xl font-bold tracking-tight text-foreground">
          Self-Hosted Setup
        </h1>
        <p className="mb-10 text-muted-foreground">
          Run PF on your own machine. Your data stays local, encrypted with your
          passphrase.
        </p>

        {/* Quick Start */}
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold text-foreground">
            Quick Start with Docker
          </h2>
          <pre className="overflow-x-auto rounded-xl bg-muted p-4 text-sm">
            <code>{`docker run -d \\
  --name pf \\
  -p 3000:3000 \\
  -v pf-data:/app/data \\
  ghcr.io/nextsoftwareconsulting/pf:latest`}</code>
          </pre>
          <p className="mt-3 text-sm text-muted-foreground">
            Then open{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              http://localhost:3000
            </code>{" "}
            in your browser.
          </p>
        </section>

        {/* Docker Compose */}
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold text-foreground">
            Or with Docker Compose
          </h2>
          <pre className="overflow-x-auto rounded-xl bg-muted p-4 text-sm">
            <code>{`services:
  app:
    image: ghcr.io/nextsoftwareconsulting/pf:latest
    ports:
      - "3000:3000"
    volumes:
      - pf-data:/app/data
    environment:
      PF_DATA_DIR: /app/data

volumes:
  pf-data:`}</code>
          </pre>
        </section>

        {/* What you get */}
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold text-foreground">
            What You Get
          </h2>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li>✓ Local SQLite database — encrypted with your passphrase</li>
            <li>✓ All data stored in a Docker volume</li>
            <li>✓ No external network calls — fully offline capable</li>
            <li>✓ Automatic updates via Docker image pulls</li>
          </ul>
        </section>

        {/* Environment Variables */}
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold text-foreground">
            Environment Variables
          </h2>
          <ul className="space-y-1 text-sm text-muted-foreground">
            <li>
              <code className="rounded bg-muted px-1 py-0.5 text-xs">
                PF_DATA_DIR
              </code>{" "}
              — data directory (default: <code className="rounded bg-muted px-1 py-0.5 text-xs">/app/data</code>)
            </li>
            <li>
              <code className="rounded bg-muted px-1 py-0.5 text-xs">PORT</code>{" "}
              — server port (default: <code className="rounded bg-muted px-1 py-0.5 text-xs">3000</code>)
            </li>
          </ul>
        </section>

        <div className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
          <strong className="text-foreground">First launch:</strong> You will be
          prompted to set a passphrase to encrypt your database. Keep it safe —
          it cannot be recovered if lost.
        </div>
      </div>
    </div>
  );
}
