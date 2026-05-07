import Link from "next/link";
import type { Metadata } from "next";
import { GoogleAnalytics } from "@/components/google-analytics";

export const metadata: Metadata = {
  title: "Finlynq vs Era — open-source MCP personal finance alternative",
  description:
    "Era is a hosted, AI-first personal finance SaaS with a closed MCP server. Finlynq is the open-source, self-hostable alternative — same MCP-driven UX, your infrastructure, your encryption keys.",
};

export default function VsEraPage() {
  return (
    <div className="min-h-screen bg-dot-pattern ambient-glow">
      <GoogleAnalytics />
      <div className="mx-auto w-full max-w-3xl px-6 py-12">
        <Link
          href="/"
          className="mb-8 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          ← Back
        </Link>

        <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary">
          <span className="text-2xl font-extrabold tracking-wide text-primary-foreground">
            FL
          </span>
        </div>

        <h1 className="mb-3 text-3xl font-bold tracking-tight text-foreground">
          Finlynq vs Era
        </h1>
        <p className="mb-10 text-muted-foreground">
          Era is a hosted, AI-first personal finance SaaS with a closed-source
          MCP server. Finlynq is the open-source, self-hostable alternative —
          same MCP-driven UX, your infrastructure, your encryption keys, no
          aggregator hostage.
        </p>

        <section className="mb-10">
          <h2 className="mb-3 text-lg font-semibold text-foreground">
            When to choose Era
          </h2>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li>
              ✓ You want bank sync to &ldquo;just work&rdquo; out of the box.
              Era ships with aggregator-grade automatic transactions across
              thousands of US institutions; Finlynq is currently file/email
              import only.
            </li>
            <li>
              ✓ You want a native iOS/Android app today. Era&rsquo;s Agency is
              a real native mobile app; Finlynq has a mobile-friendly web UI
              but no native app yet.
            </li>
            <li>
              ✓ You want regulated investment advisory or brokerage.
              Era&rsquo;s Thesis (private beta) is an SEC-registered
              investment adviser with brokerage via Alpaca. Finlynq is not —
              and explicitly never will be.
            </li>
            <li>
              ✓ You don&rsquo;t want to think about Postgres, Docker,
              encryption keys, or password recovery. Era is hosted; that&rsquo;s
              the whole pitch.
            </li>
            <li>
              ✓ You want shared household finances baked in. Era&rsquo;s
              multi-user shared views are first-class.
            </li>
          </ul>
        </section>

        <section className="mb-10">
          <h2 className="mb-3 text-lg font-semibold text-foreground">
            When to choose Finlynq
          </h2>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li>
              ✓ <strong>You want the source code.</strong> Finlynq is AGPL v3,
              fully on GitHub. Era is closed-source.
            </li>
            <li>
              ✓ <strong>You want to self-host.</strong> Finlynq runs on your
              hardware via Docker + PostgreSQL. Era cannot be self-hosted.
            </li>
            <li>
              ✓ <strong>You want per-user encryption with keys derived from
              your password.</strong> Finlynq&rsquo;s envelope encryption
              (AES-256-GCM with scrypt-derived KEK) means even the operator
              cannot read your transaction notes, payees, tags, or display
              names.
            </li>
            <li>
              ✓ <strong>You want the bigger MCP surface.</strong> Finlynq
              exposes 90 HTTP tools and 86 stdio tools across budgets,
              transactions, portfolios, goals, loans, subscriptions, and
              rules. Era&rsquo;s public Context surface is four primary
              capabilities.
            </li>
            <li>
              ✓ <strong>You want plaintext-accounting workflows.</strong>{" "}
              Finlynq is built for users who already think in ledger files;
              Era is not.
            </li>
            <li>
              ✓ <strong>You want to own your data on the day Era pivots, gets
              acquired, or shuts down.</strong>
            </li>
          </ul>
        </section>

        <section className="mb-10">
          <h2 className="mb-3 text-lg font-semibold text-foreground">
            Side-by-side
          </h2>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted text-muted-foreground">
                <tr>
                  <th className="p-3 text-left font-medium">&nbsp;</th>
                  <th className="p-3 text-left font-medium">Finlynq</th>
                  <th className="p-3 text-left font-medium">Era</th>
                </tr>
              </thead>
              <tbody className="text-foreground">
                <tr className="border-t border-border">
                  <td className="p-3 font-medium">License</td>
                  <td className="p-3">AGPL v3</td>
                  <td className="p-3">Closed source</td>
                </tr>
                <tr className="border-t border-border">
                  <td className="p-3 font-medium">Hosting</td>
                  <td className="p-3">Self-host or managed cloud</td>
                  <td className="p-3">Hosted SaaS only</td>
                </tr>
                <tr className="border-t border-border">
                  <td className="p-3 font-medium">First-party MCP</td>
                  <td className="p-3">90 HTTP / 86 stdio tools</td>
                  <td className="p-3">~4 primary capabilities</td>
                </tr>
                <tr className="border-t border-border">
                  <td className="p-3 font-medium">MCP auth</td>
                  <td className="p-3">OAuth 2.1 + DCR / Bearer / stdio</td>
                  <td className="p-3">OAuth 2.1, scoped</td>
                </tr>
                <tr className="border-t border-border">
                  <td className="p-3 font-medium">REST/HTTP API</td>
                  <td className="p-3">Full surface mirrored from MCP</td>
                  <td className="p-3">Not publicly documented</td>
                </tr>
                <tr className="border-t border-border">
                  <td className="p-3 font-medium">Bank sync</td>
                  <td className="p-3">File / email import; no Plaid</td>
                  <td className="p-3">Aggregator-based auto-sync</td>
                </tr>
                <tr className="border-t border-border">
                  <td className="p-3 font-medium">Encryption at rest</td>
                  <td className="p-3">
                    Per-user envelope (AES-256-GCM, scrypt-derived KEK)
                  </td>
                  <td className="p-3">AES-256 at rest, operator-held keys</td>
                </tr>
                <tr className="border-t border-border">
                  <td className="p-3 font-medium">Multi-currency</td>
                  <td className="p-3">Native, per-currency cost basis</td>
                  <td className="p-3">US-feed centric</td>
                </tr>
                <tr className="border-t border-border">
                  <td className="p-3 font-medium">Investment / portfolio</td>
                  <td className="p-3">Cost basis + dividends, not advisory</td>
                  <td className="p-3">Thesis: SEC-RIA + Alpaca brokerage</td>
                </tr>
                <tr className="border-t border-border">
                  <td className="p-3 font-medium">Native mobile app</td>
                  <td className="p-3">No (mobile web)</td>
                  <td className="p-3">Yes — Agency</td>
                </tr>
                <tr className="border-t border-border">
                  <td className="p-3 font-medium">Multi-user / household</td>
                  <td className="p-3">No (single-user)</td>
                  <td className="p-3">Yes — shared views</td>
                </tr>
                <tr className="border-t border-border">
                  <td className="p-3 font-medium">Pricing</td>
                  <td className="p-3">Donation-based</td>
                  <td className="p-3">Freemium + paid tiers</td>
                </tr>
                <tr className="border-t border-border">
                  <td className="p-3 font-medium">Revenue model</td>
                  <td className="p-3">Donations</td>
                  <td className="p-3">Subscriptions</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="mb-10">
          <h2 className="mb-3 text-lg font-semibold text-foreground">
            Migrating from Era
          </h2>
          <ol className="space-y-2 text-sm text-muted-foreground">
            <li>
              1. Export your transactions and category/recurring rules from
              Era. Verify Era&rsquo;s current export options at era.app.
            </li>
            <li>
              2. Import into Finlynq via{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">
                /import/reconcile
              </code>{" "}
              — upload a CSV, review and edit each row in the staging dialog,
              approve. Multi-currency, transfer-pair detection, and dedup are
              all built into the staging flow.
            </li>
            <li>
              3. Hook up your AI client. Open Claude → Customize → Connectors
              → &ldquo;+&rdquo; → paste{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">
                https://finlynq.com/mcp
              </code>
              . OAuth handles the rest. For self-host, point Claude at your
              own deployment&rsquo;s{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">/mcp</code>{" "}
              URL.
            </li>
          </ol>
        </section>

        <section className="mb-10">
          <h2 className="mb-3 text-lg font-semibold text-foreground">FAQ</h2>
          <div className="space-y-4 text-sm text-muted-foreground">
            <div>
              <p className="font-semibold text-foreground">
                Why are you comparing yourself to a paid product when
                you&rsquo;re free?
              </p>
              <p>
                Because the comparison isn&rsquo;t price — it&rsquo;s where
                your data lives, who can read it, and what happens if the
                operator pivots. Finlynq&rsquo;s argument is structural, not a
                discount.
              </p>
            </div>
            <div>
              <p className="font-semibold text-foreground">
                Doesn&rsquo;t Era&rsquo;s bank sync make this a non-comparison
                for most users?
              </p>
              <p>
                For users who want one-click bank sync and don&rsquo;t care
                about source code or self-hosting, Era is the better default.
                Finlynq&rsquo;s audience is users who specifically don&rsquo;t
                want a third-party aggregator holding their bank credentials.
              </p>
            </div>
            <div>
              <p className="font-semibold text-foreground">
                Why does this read like a hit piece?
              </p>
              <p>
                It&rsquo;s not. Era ships real things — first-party MCP,
                OAuth-scoped tools, native mobile, an investment-advisory
                product Finlynq legally cannot offer. The honest difference
                is: Era is hosted convenience for users who trust an operator
                with their financial life, and Finlynq is the substrate for
                users who don&rsquo;t want to.
              </p>
            </div>
            <div>
              <p className="font-semibold text-foreground">
                Does Finlynq have a mobile app?
              </p>
              <p>
                Not yet. The web UI is mobile-friendly, but a native iOS /
                Android wrapper isn&rsquo;t shipped. If you need native mobile
                today, Era is ahead.
              </p>
            </div>
            <div>
              <p className="font-semibold text-foreground">
                Will Finlynq ever offer regulated investment advisory like
                Era&rsquo;s Thesis?
              </p>
              <p>
                No. Becoming an SEC-registered investment adviser is
                incompatible with the AGPL self-hostable design — the
                regulator wants a single accountable entity, the design wants
                none. Finlynq is the database; the user can hire whatever
                advisor they want against the data.
              </p>
            </div>
          </div>
        </section>

        <section className="mb-10 rounded-xl border border-border bg-muted/40 p-6">
          <h2 className="mb-2 text-lg font-semibold text-foreground">
            Try Finlynq
          </h2>
          <p className="mb-3 text-sm text-muted-foreground">
            Demo login{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              demo@finlynq.com
            </code>{" "}
            /{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              finlynq-demo
            </code>{" "}
            — resets nightly. Or self-host:
          </p>
          <pre className="overflow-x-auto rounded-xl bg-muted p-4 text-sm">
            <code>{`curl -O https://raw.githubusercontent.com/finlynq/finlynq/main/pf-app/docker-compose.yml
docker compose up -d`}</code>
          </pre>
        </section>
      </div>
    </div>
  );
}
