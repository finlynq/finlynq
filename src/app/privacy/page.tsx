import Link from "next/link";
import type { Metadata } from "next";
import { ConsentControls } from "./consent-controls";

export const metadata: Metadata = {
  title: "Privacy Policy | Finlynq",
  description:
    "What Finlynq collects, how it's encrypted, what we never share, and how to export or delete your data.",
  alternates: { canonical: "/privacy" },
  openGraph: {
    title: "Privacy Policy | Finlynq",
    description:
      "What Finlynq collects, how it's encrypted, what we never share, and how to export or delete your data.",
    url: "/privacy",
    type: "website",
    siteName: "Finlynq",
  },
};

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-6 py-16">
        <header className="mb-12 border-b border-border pb-8">
          <Link
            href="/"
            className="text-xs font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            ← Finlynq
          </Link>
          <h1 className="mt-4 text-4xl font-bold tracking-tight">Privacy Policy</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Last updated: 2026-06-18
          </p>
        </header>

        <section className="prose prose-invert max-w-none space-y-8 text-[15px] leading-relaxed">
          <p className="text-base">
            Finlynq is an open-source personal-finance app (AGPL v3). You can run
            it on your own hardware or use our managed cloud at{" "}
            <code>finlynq.com</code>. This policy covers the managed cloud. If you
            self-host, you&apos;re the data controller, so this policy doesn&apos;t
            apply to your own deployment.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">1. What we collect</h2>
          <p>
            On the managed cloud, Finlynq only stores the data you put into it
            yourself:
          </p>
          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              Account identity: a username (your choice), an email address (we
              use it only for password recovery and security alerts), and a
              password hash.
            </li>
            <li>
              Financial data you import or enter: accounts, transactions,
              budgets, investments, loans, goals, attached receipts.
            </li>
            <li>
              Operational logs: HTTP request logs (IP address, user agent, URL
              path, status code). We keep these 30 days for abuse prevention and
              debugging.
            </li>
            <li>
              MCP / API tokens you generate: we store these as one-way hashes. We
              show you the raw token once when you create it, and we can&apos;t
              show it again.
            </li>
          </ul>
          <p>
            We don&apos;t collect bank credentials. Finlynq has no Plaid, MX,
            Yodlee, or Finicity integration. Your bank login never touches our
            servers. You import data via CSV / OFX / QFX / PDF / email.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            2. How your financial data is encrypted
          </h2>
          <p>
            Finlynq uses per-user envelope encryption. Here&apos;s the short
            version:
          </p>
          <ul className="list-disc pl-6 space-y-1.5">
            <li>Each user gets a Data Encryption Key (DEK), generated at signup.</li>
            <li>
              We wrap the DEK with a Key Encryption Key (KEK) derived from your
              password using <strong>scrypt</strong> with a server-side pepper.
            </li>
            <li>
              We store sensitive fields (transaction payees, notes, tags,
              attached files, encrypted display names) as{" "}
              <strong>AES-256-GCM</strong> ciphertext with a random IV and
              authentication tags.
            </li>
            <li>
              Your DEK lives only in memory while you&apos;re signed in (sliding
              2h idle timeout). We never write it to disk in plaintext.
            </li>
            <li>
              If you forget your password, your encrypted data can&apos;t be
              recovered. That&apos;s by design.
            </li>
          </ul>

          <h2 className="text-xl font-semibold mt-12 mb-3">3. What we never share</h2>
          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              We don&apos;t sell, rent, or share your data with advertisers, data
              brokers, or any third party.
            </li>
            <li>
              We don&apos;t move money. Finlynq isn&apos;t a broker, bank,
              advisor, or SEC-registered RIA. We can&apos;t initiate transfers
              from your accounts.
            </li>
            <li>
              We don&apos;t use your financial data to train AI models. The MCP
              server lets <em>you</em> grant a third-party AI assistant access to
              your data. You stay in control: it&apos;s scoped per session and
              you can revoke it.
            </li>
            <li>
              We don&apos;t use third-party analytics inside the app. The public
              marketing pages load Google Analytics only after you explicitly
              accept the cookie banner.
            </li>
          </ul>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            4. AI assistants and the MCP server
          </h2>
          <p>
            When you connect Finlynq to an AI assistant via our MCP server, the
            assistant authenticates through OAuth 2.1 (or with a Bearer API key
            if you&apos;re using a CLI client). It only receives the data returned
            by the specific tool it calls, scoped to your account.
          </p>
          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              The AI vendor (e.g., Anthropic) sees the tool responses, since they
              pass through the model. Check the vendor&apos;s privacy policy.
            </li>
            <li>
              You can revoke an OAuth grant at any time from{" "}
              <code>Settings → Connected apps</code>.
            </li>
            <li>
              Destructive operations (bulk delete, bulk update, imports) use a
              preview-confirm-execute pattern with a server-signed token, so an AI
              can&apos;t change your data without your explicit confirmation.
            </li>
          </ul>

          <h2 className="text-xl font-semibold mt-12 mb-3">5. Sub-processors</h2>
          <p>
            The managed cloud runs on a single VPS that we operate. We don&apos;t
            use third-party data processors for the app database. The only
            outbound integrations are:
          </p>
          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              Yahoo Finance, CoinGecko, Stooq, for anonymous public-price queries
              that value your portfolio. No user data is sent.
            </li>
            <li>
              Resend, for transactional email (password reset, account alerts)
              and the optional inbound-import address.
            </li>
            <li>
              GitHub Sponsors / Ko-fi, for donation processing, only if you choose
              to donate. They handle their own KYC/payment data.
            </li>
          </ul>

          <h2 className="text-xl font-semibold mt-12 mb-3">6. Cookies and analytics</h2>
          <p>
            The app itself loads no third-party analytics, no advertising
            scripts, and no tracking pixels. Sign-in uses a single first-party
            session cookie that keeps you signed in, and it expires
            automatically.
          </p>
          <p>
            On the public marketing pages we load Google Analytics to see which
            posts bring people here. GA isn&apos;t essential, so we ask for your
            consent before loading it. You can change your mind at any time:
          </p>
          <ConsentControls />

          <h2 className="text-xl font-semibold mt-12 mb-3">
            7. Records of processing (GDPR Article 30)
          </h2>
          <p>
            If you&apos;re protected by GDPR, here&apos;s our public record of
            processing activities. We keep our internal records current and make
            them available to supervisory authorities on request.
          </p>
          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              <strong>Controller:</strong> Finlynq (operated from Canada).
              Contact: <code>privacy@finlynq.com</code>.
            </li>
            <li>
              <strong>EU representative:</strong> Per GDPR Article 27(2), no
              representative is currently designated (small-scale processing,
              no special-category data, no targeting of EU market).
            </li>
            <li>
              <strong>Purposes of processing:</strong> (1) provide the personal
              finance application; (2) authenticate users; (3) deliver MCP
              server access; (4) send transactional email; (5) prevent abuse.
            </li>
            <li>
              <strong>Lawful basis:</strong> performance of a contract (Article
              6(1)(b)) and legitimate interest for security logs (6(1)(f)).
            </li>
            <li>
              <strong>Categories of data subjects:</strong> users who sign up
              for the managed cloud at finlynq.com.
            </li>
            <li>
              <strong>Categories of personal data:</strong> username, email,
              password hash, financial data entered by user, MCP/API token
              hashes, HTTP request metadata. No special-category data.
            </li>
            <li>
              <strong>Recipients / sub-processors:</strong> see Section 5. We
              do not sell or rent personal data.
            </li>
            <li>
              <strong>Cross-border transfers:</strong> data is stored in Canada,
              which has an EU adequacy decision (Article 45). No additional
              safeguards required.
            </li>
            <li>
              <strong>Retention:</strong> see Section 9 below.
            </li>
            <li>
              <strong>Technical and organizational measures:</strong> per-user
              envelope encryption (AES-256-GCM, scrypt-derived KEK); HTTPS/TLS;
              least-privilege staff access; rate limiting and origin validation
              on the MCP endpoint; regular dependency updates.
            </li>
          </ul>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            8. Security incident response
          </h2>
          <p>Our breach response process aligns with GDPR Articles 33 and 34:</p>
          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              <strong>Detection:</strong> automated monitoring on auth endpoints,
              OAuth grant lifecycle, and unusual access patterns.
            </li>
            <li>
              <strong>Containment:</strong> on suspicion of compromise, we
              rotate <code>DEPLOY_GENERATION</code> (force-logout every session)
              and revoke OAuth grants.
            </li>
            <li>
              <strong>Notification to supervisory authority:</strong> within 72
              hours of becoming aware (Article 33(1)).
            </li>
            <li>
              <strong>Notification to affected users:</strong> when a breach is
              likely to result in high risk, without undue delay (Article 34).
            </li>
            <li>
              <strong>Reporting a vulnerability:</strong> please email{" "}
              <code>privacy@finlynq.com</code>. We&apos;ll confirm we got it
              within 48 hours.
            </li>
          </ul>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            9. Retention and deletion
          </h2>
          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              You can export your full account at any time as a JSON backup
              from <code>Settings → Data → Export</code>.
            </li>
            <li>
              You can wipe your account from{" "}
              <code>Settings → Data → Delete account</code>. This removes every
              row in every table scoped to your <code>user_id</code> in a
              single transaction.
            </li>
            <li>Operational logs are retained for 30 days, then rotated.</li>
            <li>
              Database backups are retained for 7 days. After 7 days, deleted
              account data is unrecoverable from backups.
            </li>
          </ul>

          <h2 className="text-xl font-semibold mt-12 mb-3">10. Children</h2>
          <p>
            Finlynq isn&apos;t directed at children under 16, and we don&apos;t
            knowingly collect data from children. If you spot a child&apos;s
            account, contact us and we&apos;ll delete it.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            11. Jurisdiction and your rights
          </h2>
          <p>
            Finlynq is operated from Canada. You can exercise your access,
            rectification, deletion, and portability rights at any time directly
            from <code>Settings → Data</code>; you don&apos;t need to ask us. For
            anything else (GDPR Article 15 access requests, CCPA opt-outs, EU
            data-subject requests), contact us at the address below and
            we&apos;ll respond within 30 days.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">12. Changes</h2>
          <p>
            We&apos;ll update this page when our practices change and bump the
            Last updated date at the top. We&apos;ll also announce material
            changes (a new sub-processor, a change to encryption guarantees) in
            the project{" "}
            <a
              href="https://github.com/finlynq/finlynq/blob/main/CHANGELOG.md"
              className="underline underline-offset-2 hover:text-primary"
            >
              changelog
            </a>
            .
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">13. Contact</h2>
          <p>
            Privacy questions, data-subject requests, security disclosures:{" "}
            <code>privacy@finlynq.com</code>. For source-code questions, bugs, or
            feature requests, open an issue at{" "}
            <a
              href="https://github.com/finlynq/finlynq/issues"
              className="underline underline-offset-2 hover:text-primary"
            >
              github.com/finlynq/finlynq
            </a>
            .
          </p>

          <p className="mt-12 text-xs text-muted-foreground">
            Want a plain-English walkthrough of how the encryption works in
            practice, including the honest tradeoffs (lose your password, lose
            your data; the operator can see anonymized amounts and dates)? Read{" "}
            <Link
              href="/blog/how-finlynq-encrypts-your-money"
              className="underline underline-offset-2 hover:text-primary"
            >
              How Finlynq encrypts your money
            </Link>
            . The full encryption design, including the key-derivation
            parameters and threat model, is published at{" "}
            <a
              href="https://github.com/finlynq/finlynq/blob/main/pf-app/docs/architecture/encryption.md"
              className="underline underline-offset-2 hover:text-primary"
            >
              pf-app/docs/architecture/encryption.md
            </a>
            . The code that implements it is in{" "}
            <code>pf-app/src/lib/crypto/</code>. Both are AGPL v3, so read the
            code, audit it, fork it.
          </p>
        </section>
      </div>
    </div>
  );
}
