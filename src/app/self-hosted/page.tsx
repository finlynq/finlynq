import Link from "next/link";
import { GoogleAnalytics } from "@/components/google-analytics";

export default function SelfHostedPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-dot-pattern ambient-glow">
      <GoogleAnalytics />
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
            FL
          </span>
        </div>

        <h1 className="mb-2 text-3xl font-bold tracking-tight text-foreground">
          Self-Hosted Setup
        </h1>
        <p className="mb-10 text-muted-foreground">
          Run Finlynq on your own infrastructure. App + PostgreSQL run in
          Docker, sensitive fields are encrypted at rest with a per-user
          key derived from the account password.
        </p>

        {/* Quick Start */}
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold text-foreground">
            Quick Start with Docker Compose
          </h2>
          <pre className="overflow-x-auto rounded-xl bg-muted p-4 text-sm">
            <code>{`curl -O https://raw.githubusercontent.com/finlynq/finlynq/main/pf-app/docker-compose.yml
docker compose up -d`}</code>
          </pre>
          <p className="mt-3 text-sm text-muted-foreground">
            Then open{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              http://localhost:3000
            </code>{" "}
            and register your account. Remember to change the default
            PostgreSQL password and <code className="rounded bg-muted px-1 py-0.5 text-xs">NEXTAUTH_SECRET</code>
            {" "}before exposing the container to anything but localhost.
          </p>
        </section>

        {/* What you get */}
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold text-foreground">
            What You Get
          </h2>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li>✓ Self-contained Docker Compose — app + PostgreSQL, nothing external</li>
            <li>✓ Envelope encryption on transaction text fields (payees, notes, tags, holdings)</li>
            <li>✓ MCP server for plugging in AI assistants (Claude, etc.)</li>
            <li>✓ Automatic schema migrations on container start</li>
          </ul>
        </section>

        {/* Environment Variables */}
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold text-foreground">
            Environment Variables
          </h2>
          <ul className="space-y-1 text-sm text-muted-foreground">
            <li>
              <code className="rounded bg-muted px-1 py-0.5 text-xs">DATABASE_URL</code>{" "}
              — PostgreSQL connection string (required)
            </li>
            <li>
              <code className="rounded bg-muted px-1 py-0.5 text-xs">NEXTAUTH_SECRET</code>{" "}
              — JWT signing secret, at least 32 chars of entropy (required)
            </li>
            <li>
              <code className="rounded bg-muted px-1 py-0.5 text-xs">PORT</code>{" "}
              — server port (default <code className="rounded bg-muted px-1 py-0.5 text-xs">3000</code>)
            </li>
          </ul>
        </section>

        <div className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
          <strong className="text-foreground">Security note:</strong> the envelope-encryption
          DEK is derived from your account password via scrypt. If you forget
          it, the password-reset flow wipes your data and provisions a fresh
          DEK — there is no backdoor. Back up your data via the Settings →
          Privacy & Backup panel periodically.
        </div>
      </div>
    </div>
  );
}
