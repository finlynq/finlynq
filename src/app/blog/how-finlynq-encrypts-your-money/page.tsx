import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title:
    "How Finlynq encrypts your money — envelope encryption, in plain English",
  description:
    "A walkthrough of Finlynq's encryption architecture: AES-256-GCM at rest, a per-user Data Encryption Key wrapped by a scrypt-derived key from your password, and the honest tradeoffs (operator can see anonymized amounts; lose your password, lose your data).",
  openGraph: {
    title: "How Finlynq encrypts your money",
    description:
      "AES-256-GCM, a scrypt-derived key from your password, a per-user DEK, and the honest tradeoffs.",
    type: "article",
    url: "https://finlynq.com/blog/how-finlynq-encrypts-your-money",
  },
};

export default function HowFinlynqEncryptsYourMoneyPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-6 py-16">
        <header className="mb-12 border-b border-border pb-8">
          <Link
            href="/blog"
            className="text-xs font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            ← Finlynq blog
          </Link>
          <h1 className="mt-4 text-4xl font-bold tracking-tight">
            How Finlynq encrypts your money
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Envelope encryption, in plain English · Published 2026-05-13
          </p>
        </header>

        <article className="prose prose-invert max-w-none space-y-6 text-[15px] leading-relaxed">
          <p className="text-base">
            If your AI assistant can read your money, who else can? That is the
            question I had to answer for myself before I felt okay handing a
            language model the keys to my real bank data. This post is the
            honest answer for Finlynq — what is encrypted, what is not, what
            tradeoffs I accepted, and where you can read the code that
            implements it.
          </p>

          <p>
            I built Finlynq partly because I wanted a personal-finance app that
            an AI could query without me having to email a CSV to a chatbot. The
            unavoidable second question once you build that is: how do you keep
            the operator (me) honest? Finlynq runs on a single VPS I own. If I
            wanted to read your transactions, what would stop me?
          </p>

          <p>
            The answer is{" "}
            <strong>per-user envelope encryption with a key derived from your password</strong>
            , and it has real teeth. It also has real limits. Both halves are in
            this post.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            1. The threat model — what we are and aren&apos;t protecting against
          </h2>

          <p>
            Encryption schemes only make sense relative to a threat. Here are
            the threats Finlynq&apos;s design takes seriously:
          </p>

          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              <strong>Stolen database dump.</strong> Someone gets read access to
              the Postgres database — disk image, pg_dump, or an unauthorized
              backup copy. They should not be able to read your merchant names,
              account names, notes, tags, or categories from that dump alone.
            </li>
            <li>
              <strong>Stolen database <em>and</em> server filesystem.</strong>{" "}
              An attacker has the DB plus the server&apos;s environment
              variables. The pepper helps (more below), but they would still
              need to brute-force every user&apos;s password individually.
              That&apos;s slow on purpose.
            </li>
            <li>
              <strong>Stale backups in cloud storage.</strong> Database backups
              are encrypted on disk with a symmetric key kept off the host, so a
              copy floating around a backup bucket does not equal a breach.
            </li>
            <li>
              <strong>Cross-tenant data leaks.</strong> One user&apos;s data
              should never become readable by another user via a buggy import,
              backup restore, or account wipe.
            </li>
          </ul>

          <p>
            Here are the threats Finlynq does <em>not</em> claim to defend
            against — and you should know this before you trust the system:
          </p>

          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              <strong>A malicious or compromised operator at runtime.</strong>{" "}
              When you are signed in, your decryption key is held in the
              server&apos;s memory. An attacker who roots the server while you
              are using it can read it. There is no honest way around this for
              a web app that responds to your queries server-side; only a true
              client-side-only design avoids it, and that comes with its own
              set of compromises (no server-side aggregation, no MCP, no AI
              assistant access).
            </li>
            <li>
              <strong>The amounts and dates of your transactions.</strong> These
              are stored as plain numbers and dates in the database. They must
              be — otherwise the app could not sum your spending, compute a
              budget, or feed an AI assistant a portfolio analysis without your
              browser doing all the math. The operator can see anonymized
              amounts and dates. They are useless without the labels, but they
              are not encrypted.
            </li>
            <li>
              <strong>The structure of your data.</strong> The fact that you
              have 14 accounts, 320 transactions a month, and a 7.4% savings
              rate is visible to the operator. Just not <em>what</em> any of
              them are for.
            </li>
            <li>
              <strong>Side-channel inference.</strong> If your &ldquo;Account
              #3&rdquo; has a recurring $1,847.00 charge on the 15th of every
              month and you live in a major city, a determined operator could
              guess &ldquo;that&apos;s probably rent.&rdquo; Encryption does
              not stop guesses. It stops <em>reading</em>.
            </li>
            <li>
              <strong>A subpoena.</strong> Operators get subpoenaed. Finlynq is
              operated from Canada and we have a privacy policy with retention
              rules, but a court order is a court order — what we could be
              compelled to hand over is the encrypted data plus whatever
              metadata the database contains. Without your password, even we
              cannot read the labels.
            </li>
          </ul>

          <p>
            If any of the second list is a dealbreaker for you, self-hosting is
            the right answer. Finlynq is AGPL v3 — the same code runs on your
            laptop or homelab as on our managed cloud. The full self-hosting
            guide is at{" "}
            <Link href="/self-hosted" className="underline underline-offset-2 hover:text-primary">
              /self-hosted
            </Link>
            .
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            2. The architecture in plain language
          </h2>

          <p>
            The pattern Finlynq uses is called <strong>envelope encryption</strong>.
            It&apos;s the same shape AWS KMS, Google Cloud KMS, and most
            password managers use. Two keys, not one:
          </p>

          <ol className="list-decimal pl-6 space-y-2">
            <li>
              A <strong>Data Encryption Key</strong> (DEK) — 32 random bytes,
              one per user, generated the moment you sign up. This is the key
              that actually encrypts your fields.
            </li>
            <li>
              A <strong>Key Encryption Key</strong> (KEK) — derived from your
              password every time you sign in. The KEK&apos;s only job is to
              wrap and unwrap the DEK.
            </li>
          </ol>

          <p>
            The DEK never leaves the server, but it&apos;s only useful when
            unwrapped, and unwrapping requires your password. Here&apos;s the
            sequence in slightly more detail.
          </p>

          <p>
            <strong>When you sign up:</strong>
          </p>
          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              Finlynq generates a fresh, random 32-byte DEK using the OS random
              source.
            </li>
            <li>
              It also generates a 16-byte random salt and runs your password
              through{" "}
              <a
                href="https://www.rfc-editor.org/rfc/rfc7914"
                className="underline underline-offset-2 hover:text-primary"
              >
                scrypt
              </a>{" "}
              with parameters{" "}
              <code>N = 2<sup>16</sup>, r = 8, p = 1</code> — roughly 64 MB of
              memory and ~80 ms of compute per derivation on modern hardware.
              That&apos;s the KEK.
            </li>
            <li>
              The DEK is wrapped (encrypted) with the KEK using AES-256-GCM,
              and the wrapped DEK plus the salt are stored in your{" "}
              <code>users</code> row.
            </li>
            <li>
              The raw KEK is discarded the moment the wrap finishes. The
              database now contains a wrapped DEK and a salt — and nothing on
              the server can unwrap that DEK without your password.
            </li>
          </ul>

          <p>
            <strong>When you sign in:</strong>
          </p>
          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              You send your password over HTTPS. The server checks it against
              the stored hash, then re-runs scrypt with your stored salt to
              re-derive your KEK.
            </li>
            <li>
              It uses the KEK to unwrap your DEK and caches the raw DEK in
              memory, keyed by your session id.
            </li>
            <li>
              The KEK is again discarded immediately. The cache holds only the
              DEK, and only for the lifetime of your session — with a sliding
              2-hour idle timeout. If you walk away from your laptop for the
              afternoon, your DEK is gone from memory by the time you come
              back, and the next request decrypts nothing until you sign in
              again.
            </li>
          </ul>

          <p>
            <strong>When the app reads or writes a sensitive field:</strong>
          </p>
          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              For every encrypted column on every row, Finlynq runs AES-256-GCM
              with a freshly-random 12-byte IV. The output is stored as{" "}
              <code>v1:&lt;base64 iv&gt;:&lt;base64 ciphertext&gt;:&lt;base64 auth-tag&gt;</code>.
              The{" "}
              <code>v1:</code> prefix is a version marker so we can rotate
              schemes later without ambiguity.
            </li>
            <li>
              GCM is an{" "}
              <em>authenticated</em> encryption mode — every row has a 16-byte
              authentication tag that&apos;s checked on decrypt. If a single bit
              of the ciphertext was tampered with, decryption fails loudly
              instead of returning subtly wrong plaintext.
            </li>
            <li>
              Random IV per row means even if two transactions have the exact
              same payee name, their ciphertexts are completely different. The
              operator can&apos;t even tell that &ldquo;you shop at the same
              place twice.&rdquo;
            </li>
          </ul>

          <p>
            One extra detail worth calling out: the password input to scrypt is
            not the raw password. It&apos;s{" "}
            <code>HMAC-SHA256(server-pepper, password)</code>, where the pepper
            is a long random secret stored in the server&apos;s environment and
            never in the database. The pepper exists to defend against a
            database-only leak: even a stolen DB plus a 1080 Ti can&apos;t
            mount an offline scrypt-cracking run without also stealing the
            pepper out of the server&apos;s environment. The pepper is not a
            user-facing feature — losing it is the same as losing the DB — but
            it raises the bar against database-only theft, which is the most
            common breach shape.
          </p>

          <p>
            The full key-derivation code is at{" "}
            <a
              href="https://github.com/finlynq/finlynq/blob/main/pf-app/src/lib/crypto/envelope.ts"
              className="underline underline-offset-2 hover:text-primary"
            >
              <code>pf-app/src/lib/crypto/envelope.ts</code>
            </a>
            . It&apos;s about 280 lines including comments. AGPL v3, read it
            yourself.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            3. What this means in practice
          </h2>

          <p>
            Here is what the operator (me) can and cannot see when I open a
            psql shell against the production database:
          </p>

          <p>
            <strong>I cannot decrypt:</strong>
          </p>
          <ul className="list-disc pl-6 space-y-1.5">
            <li>The payee on any transaction.</li>
            <li>The free-text note on any transaction or split.</li>
            <li>The tags on any transaction.</li>
            <li>
              The display names of your accounts, categories, goals, loans,
              subscriptions, and portfolio holdings. These were the last
              plaintext labels in the database — they were physically dropped
              from the schema on 2026-05-03 in a project we called Stream D
              Phase 4. The plaintext columns are gone; only the encrypted
              versions remain.
            </li>
            <li>
              The encrypted attachment of any receipt you upload to the file
              store.
            </li>
            <li>The aliases you assigned to your accounts.</li>
          </ul>

          <p>
            <strong>I can see:</strong>
          </p>
          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              The numeric amount of every transaction, and the currency code.
            </li>
            <li>
              The transaction date and the date the row was created or last
              updated.
            </li>
            <li>
              The integer foreign keys that connect a transaction to an
              (encrypted-name) account and an (encrypted-name) category.
            </li>
            <li>
              Whether a row is a regular transaction, a transfer, an income, or
              an expense — the one-character{" "}
              <code>type</code> column (<code>E</code> / <code>I</code> /{" "}
              <code>R</code> / <code>T</code>) is plaintext because the
              category-vs-sign invariant has to be checked server-side.
            </li>
            <li>
              How many accounts, categories, goals, and holdings you have, and
              the structural shape of your portfolio (counts, dates, integer
              IDs).
            </li>
          </ul>

          <p>
            In other words: I can see &ldquo;there&apos;s a $42.18 expense on
            2026-04-09 in category #14, account #3.&rdquo; I cannot see what
            category #14 is, what account #3 is, who the payee was, or what
            note you wrote on it. The amounts and dates are visible. The labels
            are not.
          </p>

          <p>
            This is the honest version of the privacy claim. The landing page
            says &ldquo;Mathematically private,&rdquo; and that&apos;s true{" "}
            <em>about the labels</em> — they really are sealed by a key derived
            from your password. But it overstates the case if you read it as
            &ldquo;the operator sees nothing.&rdquo; The operator sees plenty.
            The operator just can&apos;t read the labels that turn those
            numbers into meaningful information about your life.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            4. The honest tradeoffs
          </h2>

          <p>
            Three tradeoffs worth being explicit about.
          </p>

          <p>
            <strong>Tradeoff 1: lose your password, lose your data.</strong>{" "}
            Finlynq has no recovery key, no admin override, no master
            decryption key kept on ice for emergencies. If you forget your
            password, the &ldquo;reset&rdquo; flow does the only thing it
            cryptographically can: it wipes all your data and provisions a
            fresh DEK under your new password. There is no way to call support
            and recover what was in there. This is by design — any recovery
            mechanism would necessarily mean Finlynq holds something that can
            decrypt your data, which is exactly what we&apos;re promising
            isn&apos;t the case.
          </p>

          <p>
            This is a real cost. People do forget passwords. The mitigation is
            simple but boring: pick a password from a password manager, write
            it down somewhere physically secure, and export an unencrypted JSON
            backup to your own machine periodically (Settings → Data →
            Export). Finlynq can&apos;t save you from losing your password, but
            you can save yourself.
          </p>

          <p>
            <strong>Tradeoff 2: amounts and dates are not encrypted.</strong>{" "}
            Some personal-finance apps encrypt the amounts too, computing all
            aggregations in the browser. That&apos;s a defensible design — it
            shrinks what the operator can see — but it also makes the things
            Finlynq cares most about (server-side MCP tools, aggregate queries
            from an AI assistant, multi-currency conversion, the FIRE
            calculator) either impossible or very slow. We made the call that
            the value of an AI being able to answer &ldquo;what was my total
            spend last month?&rdquo; server-side outweighs the marginal privacy
            cost of the operator seeing un-labelled amounts.
          </p>

          <p>
            If you disagree with that call — and reasonable people do — the
            answer is self-hosting. When you self-host, &ldquo;the operator
            sees the amounts&rdquo; collapses to &ldquo;you see the
            amounts,&rdquo; which presumably is fine.
          </p>

          <p>
            <strong>Tradeoff 3: deploys briefly degrade the read path.</strong>{" "}
            The DEK cache lives in process memory, so when Finlynq restarts —
            for a deploy, a crash, a maintenance window — every signed-in user
            momentarily has a valid session cookie but no cached DEK on the
            server. Rather than 503ing every page until everyone re-logs in,
            read paths handle this gracefully: encrypted fields render as a
            placeholder, the app keeps working, and the next sign-in restores
            normal display. Writes that need the key block until you re-sign-in,
            because silently writing plaintext into encrypted columns would be
            worse than blocking. There&apos;s also a deploy-generation marker
            that proactively invalidates old sessions across a deploy boundary
            so you get a clean re-auth instead of a degraded one.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            5. Why this matters for the AI-in-finance question
          </h2>

          <p>
            Finlynq&apos;s pitch is &ldquo;track your money here, analyze it
            anywhere.&rdquo; The &ldquo;anywhere&rdquo; is the{" "}
            <a
              href="https://modelcontextprotocol.io"
              className="underline underline-offset-2 hover:text-primary"
            >
              Model Context Protocol
            </a>{" "}
            server — 91 tools that let Claude, ChatGPT, Cursor, or any other
            MCP-compatible AI assistant query and mutate your financial data on
            your behalf.
          </p>

          <p>
            The encryption model matters here because of a question every
            cautious user asks before they connect an AI to their bank data:{" "}
            <em>where does the data actually go, and who sees it?</em>
          </p>

          <p>
            The answer for Finlynq is layered:
          </p>

          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              Your <strong>raw data</strong> lives in Finlynq&apos;s database,
              with the labels encrypted at rest as described above.
            </li>
            <li>
              When an AI assistant calls an MCP tool, it authenticates with
              either OAuth 2.1, a Bearer API key, or stdio. The server unwraps
              your DEK on that request, decrypts only what that tool needs to
              return, and the tool&apos;s response goes back to the AI as
              plaintext JSON. The AI provider (Anthropic, OpenAI, whoever) does
              see that response — that is unavoidable if you want the AI to
              answer questions about it.
            </li>
            <li>
              That MCP session is <em>scoped</em>: it gets read-only or
              read-write tools according to the OAuth scope you granted; you
              can revoke the grant from Settings → Connected apps at any time;
              destructive operations require a preview-then-confirm
              cryptographic token so the AI cannot mutate your data without
              your explicit step.
            </li>
            <li>
              We do not train models on your data. The MCP server is a tool
              gateway, not an ingest pipeline. Anything that crosses the AI
              vendor&apos;s API is governed by{" "}
              <em>their</em> privacy policy — refer to{" "}
              <a
                href="https://www.anthropic.com/legal/privacy"
                className="underline underline-offset-2 hover:text-primary"
              >
                Anthropic&apos;s
              </a>{" "}
              or{" "}
              <a
                href="https://openai.com/policies/privacy-policy"
                className="underline underline-offset-2 hover:text-primary"
              >
                OpenAI&apos;s
              </a>{" "}
              for the details — but the connection from your data to that
              vendor is one you explicitly authorize and can revoke.
            </li>
          </ul>

          <p>
            So if you&apos;re worried about AI assistants getting access to
            your financial life: the answer isn&apos;t &ldquo;never grant the
            access.&rdquo; The useful answer is &ldquo;grant a scoped,
            revocable, observable session, and use a backend that can&apos;t
            read the data on its own.&rdquo; That second half is what the
            encryption model buys you.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            6. Where to learn more
          </h2>

          <p>
            Everything in this post is described in more rigorous detail in the
            architecture docs, and the code that implements it is published
            under AGPL v3:
          </p>

          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              <a
                href="https://github.com/finlynq/finlynq/blob/main/pf-app/docs/architecture/encryption.md"
                className="underline underline-offset-2 hover:text-primary"
              >
                <code>pf-app/docs/architecture/encryption.md</code>
              </a>{" "}
              — the authoritative technical reference. Covers Phase 2, Phase 3,
              and the Stream D rollout that finally encrypted display names; the
              auth-tag failure resilience helper that prevented a class of
              regressions; the wipe-account primitive; the backup-restore
              foreign-key remap; the grace migration for pre-encryption
              accounts.
            </li>
            <li>
              <a
                href="https://github.com/finlynq/finlynq/tree/main/pf-app/src/lib/crypto"
                className="underline underline-offset-2 hover:text-primary"
              >
                <code>pf-app/src/lib/crypto/</code>
              </a>{" "}
              — the implementation. Roughly 1,500 lines across envelope, key
              cache, column helpers, staging envelope, file envelope. Small
              enough to read in an afternoon.
            </li>
            <li>
              <a
                href="https://github.com/finlynq/finlynq/blob/main/STREAM_D.md"
                className="underline underline-offset-2 hover:text-primary"
              >
                <code>STREAM_D.md</code>
              </a>{" "}
              — the design doc for the display-name encryption rollout. Useful
              if you want to understand the parallel{" "}
              <code>(name_ct, name_lookup)</code> column pattern that lets
              encrypted strings still support exact-match SQL queries and
              per-user unique constraints.
            </li>
            <li>
              <Link
                href="/privacy"
                className="underline underline-offset-2 hover:text-primary"
              >
                /privacy
              </Link>{" "}
              — the policy version of all this, with GDPR Article 30 records,
              retention rules, and the sub-processor list.
            </li>
            <li>
              <Link
                href="/self-hosted"
                className="underline underline-offset-2 hover:text-primary"
              >
                /self-hosted
              </Link>{" "}
              — if the &ldquo;trust the operator&rdquo; layer is the part you
              want to skip, run Finlynq on your own hardware. Same code, same
              encryption, you&apos;re the operator.
            </li>
          </ul>

          <p>
            And if you find something in the design or the code that&apos;s
            wrong — or weaker than this post claims — please tell me. Email{" "}
            <code>privacy@finlynq.com</code>, or open an issue at{" "}
            <a
              href="https://github.com/finlynq/finlynq/issues"
              className="underline underline-offset-2 hover:text-primary"
            >
              github.com/finlynq/finlynq/issues
            </a>
            . An honest threat model is more useful than a confident one, and
            the only way it stays honest is if people who know more than me
            keep poking holes.
          </p>

          <p className="mt-12 text-xs text-muted-foreground">
            Hussein Halawi, founder · 2026-05-13. Corrections welcome.
          </p>
        </article>
      </div>
    </div>
  );
}
