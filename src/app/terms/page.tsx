import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service — Finlynq",
  description:
    "Terms governing the Finlynq managed cloud service at finlynq.com. Self-hosted use of the source code is governed by AGPL v3.",
};

export default function TermsPage() {
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
          <h1 className="mt-4 text-4xl font-bold tracking-tight">Terms of Service</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Effective: 2026-05-09
          </p>
        </header>

        <section className="prose prose-invert max-w-none space-y-8 text-[15px] leading-relaxed">
          <p className="text-base">
            These Terms of Service (&ldquo;Terms&rdquo;) govern your use of the
            Finlynq managed cloud service available at <code>finlynq.com</code>{" "}
            (the &ldquo;Service&rdquo;). Finlynq is an open-source personal
            finance application; the source code is licensed under the{" "}
            <a
              href="https://www.gnu.org/licenses/agpl-3.0.en.html"
              className="underline underline-offset-2 hover:text-primary"
            >
              GNU Affero General Public License v3
            </a>{" "}
            and is published at{" "}
            <a
              href="https://github.com/finlynq/finlynq"
              className="underline underline-offset-2 hover:text-primary"
            >
              github.com/finlynq/finlynq
            </a>
            . If you run the software on your own infrastructure, your use is
            governed by the AGPL v3 license in the repository and these Terms
            do not apply to that deployment.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            1. Acceptance of Terms
          </h2>
          <p>
            By creating an account on the Service, accessing the Service, or
            connecting an AI assistant to your Finlynq account via our MCP
            server, you agree to these Terms. If you do not agree, do not use
            the Service. You may instead self-host the open-source software
            under the AGPL v3.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">2. The Service</h2>
          <p>
            Finlynq is a personal-finance tracking application. It lets you
            record accounts, transactions, budgets, investments, loans, and
            goals, and query that data through a built-in UI or through an MCP
            (Model Context Protocol) server that exposes your data to AI
            assistants you authorize.
          </p>
          <p>
            The Service is offered in two forms:
          </p>
          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              <strong>Managed cloud:</strong> hosted at <code>finlynq.com</code>{" "}
              and operated by us. These Terms govern that use.
            </li>
            <li>
              <strong>Self-hosted:</strong> you run the source code on your own
              hardware. That use is governed by the AGPL v3 license file in the
              repository, not by these Terms. We provide the software as-is and
              have no operational role in your self-hosted deployment.
            </li>
          </ul>

          <h2 className="text-xl font-semibold mt-12 mb-3">3. Eligibility</h2>
          <p>
            You must be at least 16 years old to use the Service. By creating
            an account, you represent that you meet this minimum age and that
            you have the legal capacity to enter into these Terms in your
            jurisdiction. The Service is not directed at children under 16 and
            we do not knowingly accept accounts from them.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            4. Account Registration and Security
          </h2>
          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              You choose a username and provide a recovery email address. Your
              password is hashed; we never see or store it in clear text.
            </li>
            <li>
              Your financial data is encrypted with a Data Encryption Key (DEK)
              wrapped by a Key Encryption Key derived from your password. If
              you forget your password, your encrypted data cannot be
              recovered. This is by design. Export your data regularly.
            </li>
            <li>
              You are responsible for keeping your credentials, MCP/API
              tokens, and OAuth grants confidential. Notify us promptly if you
              suspect unauthorized access.
            </li>
            <li>
              One person per account. You may not share an account with
              someone else or operate the account on behalf of a third party
              without their authorization.
            </li>
          </ul>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            5. Open-Source License
          </h2>
          <p>
            The Finlynq source code is licensed under the{" "}
            <a
              href="https://www.gnu.org/licenses/agpl-3.0.en.html"
              className="underline underline-offset-2 hover:text-primary"
            >
              GNU Affero General Public License v3
            </a>
            . You may fork, modify, study, and redistribute the source code
            subject to the AGPL v3, including the network-use clause (Section
            13) which requires you to publish modified source if you operate a
            modified version as a network service.
          </p>
          <p>
            These Terms govern <em>only</em> the managed cloud service we
            operate at <code>finlynq.com</code>. They do not modify, restrict,
            or override the AGPL v3 rights granted by the license file in the
            repository for users of the source code.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            6. Acceptable Use Policy
          </h2>
          <p>You agree not to:</p>
          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              Use the Service to violate any law or the rights of any third
              party.
            </li>
            <li>
              Attempt to break or bypass authentication, decrypt other users&apos;
              data, exploit vulnerabilities, or access systems or accounts you
              are not authorized to access.
            </li>
            <li>
              Run automated scrapers or load-generators against the Service,
              or otherwise interfere with availability for other users. Normal
              programmatic use through the MCP server and the documented API
              endpoints with your own credentials is permitted.
            </li>
            <li>
              Resell, white-label, or sub-license access to the managed cloud
              service. You may, of course, self-host under the AGPL v3.
            </li>
            <li>
              Upload content that infringes intellectual property, is unlawful,
              or contains malware.
            </li>
            <li>
              Use the Service to send unsolicited bulk messages, including via
              the inbound-import email address.
            </li>
          </ul>
          <p>
            We may suspend or terminate accounts that violate this section.
            Egregious violations (active intrusion attempts, malware
            distribution) may be terminated without notice.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            7. User Data Ownership and Portability
          </h2>
          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              You own the data you put into the Service. We claim no
              ownership of your financial records, notes, attachments, or any
              other content you upload.
            </li>
            <li>
              You can export your full account at any time as a JSON backup
              from <code>Settings → Data → Export</code>.
            </li>
            <li>
              You can permanently delete your account from{" "}
              <code>Settings → Data → Delete account</code>. This removes every
              row scoped to your <code>user_id</code> across all of our tables
              in a single transaction. Database backups are retained for 7
              days; after that window, deleted data is unrecoverable from
              backups.
            </li>
            <li>
              We do not sell, rent, or share your data with advertisers or
              data brokers. We do not use your financial data to train AI
              models. See the{" "}
              <Link
                href="/privacy"
                className="underline underline-offset-2 hover:text-primary"
              >
                Privacy Policy
              </Link>{" "}
              for full detail.
            </li>
          </ul>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            8. No Financial Services
          </h2>
          <p>
            Finlynq is a personal-finance <em>tracking</em> application.
            Finlynq is not, and does not hold itself out as:
          </p>
          <ul className="list-disc pl-6 space-y-1.5">
            <li>a broker, dealer, or money transmitter;</li>
            <li>a bank or financial institution;</li>
            <li>
              a registered investment advisor, financial planner, or fiduciary;
            </li>
            <li>a tax advisor or accountant.</li>
          </ul>
          <p>
            The Service does not execute trades, transfer funds, hold money,
            or initiate any transaction with your real-world financial
            accounts. Numbers, charts, projections, and AI-generated
            commentary in the Service are informational only and are not
            investment, tax, legal, or financial advice. Consult a qualified
            professional before making financial decisions. You are solely
            responsible for the accuracy of the data you enter and for any
            decisions you make based on what you see in the Service.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">9. Donations</h2>
          <p>
            The managed cloud is funded by voluntary donations through{" "}
            <a
              href="https://github.com/sponsors/finlynq"
              className="underline underline-offset-2 hover:text-primary"
            >
              GitHub Sponsors
            </a>{" "}
            and{" "}
            <a
              href="https://ko-fi.com/finlynq"
              className="underline underline-offset-2 hover:text-primary"
            >
              Ko-fi
            </a>
            . Donations are voluntary, non-refundable except where required by
            law, and do not entitle you to any service-level guarantee, paid
            tier, additional feature, or priority support. There are no paid
            tiers and no subscriptions. If donations do not sustain operating
            costs, we may discontinue the managed cloud — see Section 14.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            10. Disclaimers and &ldquo;As-Is&rdquo; Service
          </h2>
          <p>
            THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS
            AVAILABLE&rdquo; WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
            INCLUDING WITHOUT LIMITATION WARRANTIES OF MERCHANTABILITY,
            FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, ACCURACY,
            UNINTERRUPTED OPERATION, OR FREEDOM FROM ERROR. WE DO NOT WARRANT
            THAT THE SERVICE WILL MEET YOUR REQUIREMENTS, BE AVAILABLE WITHOUT
            INTERRUPTION, OR BE FREE OF DEFECTS.
          </p>
          <p>
            We do not offer a service-level agreement (SLA), uptime guarantee,
            or recovery-time objective. The Service is operated on a single
            VPS by a small team and may be unavailable for maintenance,
            failure, or other reasons. Export your data regularly.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            11. Limitation of Liability
          </h2>
          <p>
            TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT
            SHALL FINLYNQ OR ITS OPERATOR BE LIABLE FOR ANY INDIRECT,
            INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE
            DAMAGES, INCLUDING WITHOUT LIMITATION DAMAGES FOR LOST PROFITS,
            LOST REVENUE, LOST OR INACCURATE DATA, BUSINESS INTERRUPTION, OR
            LOSS OF GOODWILL, ARISING OUT OF OR RELATED TO YOUR USE OF (OR
            INABILITY TO USE) THE SERVICE, EVEN IF ADVISED OF THE POSSIBILITY
            OF SUCH DAMAGES.
          </p>
          <p>
            Our aggregate liability arising out of or related to these Terms
            or the Service shall not exceed the greater of (a) the total
            amount you have donated to Finlynq in the twelve months preceding
            the event giving rise to the claim, or (b) one hundred Canadian
            dollars (CA$100). Some jurisdictions do not allow the exclusion or
            limitation of certain damages, in which case the above limits
            apply to the extent permitted by law.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            12. Third-Party Services
          </h2>
          <p>
            The Service integrates with the following third parties to
            function. We do not control their accuracy, availability, or
            terms, and we are not responsible for outages, data errors, or
            changes on their side:
          </p>
          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              <strong>Price feeds:</strong> Yahoo Finance (equities, FX),
              CoinGecko (crypto), Stooq (precious metals). Quotes are anonymous
              public-price queries with no user data attached. Prices may be
              delayed, missing, or incorrect.
            </li>
            <li>
              <strong>Email:</strong> Resend processes transactional email
              (password reset, alerts) and the optional inbound-import
              address.
            </li>
            <li>
              <strong>Donations:</strong> GitHub Sponsors and Ko-fi handle
              their own KYC and payment processing.
            </li>
            <li>
              <strong>AI assistants:</strong> when you authorize Anthropic
              Claude or another AI client through the MCP server, the
              assistant&apos;s vendor sees the tool responses returned to it.
              Their privacy policies apply to that side of the connection.
            </li>
          </ul>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            13. Indemnification
          </h2>
          <p>
            You agree to indemnify and hold harmless Finlynq and its operator
            from any claim, demand, loss, or damage (including reasonable
            legal fees) arising out of (a) your breach of these Terms, (b)
            your violation of any law or third-party right, or (c) content or
            data you uploaded that infringes the rights of any third party.
            We reserve the right, at our own expense, to assume the exclusive
            defense and control of any matter otherwise subject to
            indemnification by you.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">14. Termination</h2>
          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              <strong>By you:</strong> you may stop using the Service at any
              time and delete your account from <code>Settings → Data → Delete
              account</code>.
            </li>
            <li>
              <strong>By us, for cause:</strong> we may suspend or terminate
              your account immediately if you violate Section 6 (Acceptable
              Use) or applicable law.
            </li>
            <li>
              <strong>By us, for convenience:</strong> if the managed cloud is
              no longer sustainable (donations don&apos;t cover operating
              costs, the operator can no longer maintain it, or other
              good-faith reason), we may discontinue the Service or your
              account with at least 30 days&apos; notice via in-app banner or
              email. Your data export will remain available throughout the
              notice period.
            </li>
            <li>
              <strong>Survival:</strong> Sections 7 (data deletion mechanics),
              8 (No Financial Services), 10 (Disclaimers), 11 (Limitation of
              Liability), 13 (Indemnification), and 16 (Governing Law) survive
              termination.
            </li>
          </ul>
          <p>
            Even if the managed cloud is discontinued, the source code remains
            available under AGPL v3 and you can continue using Finlynq by
            self-hosting it.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            15. Changes to Terms
          </h2>
          <p>
            We may update these Terms when our practices change. For{" "}
            <strong>material changes</strong> (anything that meaningfully
            reduces your rights or expands your obligations), we will give at
            least 30 days&apos; notice via an in-app banner or an email to
            your recovery address. Continued use of the Service after the
            effective date constitutes acceptance. For minor changes (typo
            fixes, clarifications, formatting), the updated Terms take effect
            immediately on posting. The current effective date is shown at
            the top of this page.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            16. Governing Law and Dispute Resolution
          </h2>
          <p>
            These Terms are governed by the laws of the Province of Ontario,
            Canada, and the federal laws of Canada applicable therein, without
            regard to conflict-of-laws principles. The courts located in
            Ontario, Canada will have exclusive jurisdiction over any dispute
            arising out of or related to these Terms or the Service, except
            that you may also bring a claim in your local courts if required
            by your jurisdiction&apos;s consumer-protection law.
          </p>
          <p>
            Before filing a formal claim, please contact us first using the
            address below; we will try in good faith to resolve the dispute
            informally within 30 days.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">17. Contact</h2>
          <p>
            Questions about these Terms:{" "}
            <code>privacy@finlynq.com</code> (the same address handles legal
            and privacy correspondence). Source-code questions, bugs, or
            feature requests: open an issue at{" "}
            <a
              href="https://github.com/finlynq/finlynq/issues"
              className="underline underline-offset-2 hover:text-primary"
            >
              github.com/finlynq/finlynq
            </a>
            .
          </p>

          <p className="mt-12 text-xs text-muted-foreground">
            See also our{" "}
            <Link
              href="/privacy"
              className="underline underline-offset-2 hover:text-primary"
            >
              Privacy Policy
            </Link>{" "}
            for what data we collect and how it is encrypted, and the AGPL v3
            license file in the{" "}
            <a
              href="https://github.com/finlynq/finlynq/blob/main/LICENSE"
              className="underline underline-offset-2 hover:text-primary"
            >
              repository
            </a>{" "}
            for the terms governing self-hosted use of the source code.
          </p>
        </section>
      </div>
    </div>
  );
}
