import Link from "next/link";
import type { Metadata } from "next";
import { AnalyticsConsent } from "@/components/analytics-consent";
import {
  JsonLd,
  articleSchema,
  breadcrumbSchema,
} from "@/components/seo/json-ld";

const SLUG = "how-finlynq-encrypts-your-money";
const PUBLISHED = "2026-05-13";

export const metadata: Metadata = {
  title:
    "How Finlynq encrypts your money: envelope encryption, in plain English",
  description:
    "A walkthrough of Finlynq's encryption: AES-256-GCM at rest, a per-user Data Encryption Key wrapped by a scrypt-derived key from your password, and the tradeoffs I won't pretend away (the operator can see anonymized amounts; lose your password and your data is gone).",
  alternates: { canonical: `/blog/${SLUG}` },
  openGraph: {
    title: "How Finlynq encrypts your money",
    description:
      "AES-256-GCM, a scrypt-derived key from your password, a per-user DEK, and the honest tradeoffs.",
    type: "article",
    url: `/blog/${SLUG}`,
    siteName: "Finlynq",
  },
  twitter: {
    card: "summary_large_image",
    title: "How Finlynq encrypts your money",
    description:
      "Envelope encryption in plain English: AES-256-GCM, a scrypt-derived key, a per-user DEK, and the honest tradeoffs.",
  },
};

export default function HowFinlynqEncryptsYourMoneyPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <AnalyticsConsent />
      <JsonLd
        data={articleSchema({
          title: "How Finlynq encrypts your money",
          description:
            "A walkthrough of Finlynq's encryption architecture: AES-256-GCM at rest, a per-user DEK wrapped by a scrypt-derived key, and the honest tradeoffs.",
          path: `/blog/${SLUG}`,
          datePublished: PUBLISHED,
        })}
      />
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Blog", path: "/blog" },
          { name: "How Finlynq encrypts your money", path: `/blog/${SLUG}` },
        ])}
      />
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
            If your AI assistant can read your money, who else can? I had to
            answer that for myself before I felt okay handing a language model
            the keys to my real bank data. So here&apos;s the honest answer for
            Finlynq. What&apos;s encrypted, what isn&apos;t, the tradeoffs I
            made my peace with, and where you can go read the code that does it.
          </p>

          <p>
            I built Finlynq partly because I wanted a personal-finance app an AI
            could query without me emailing a CSV to a chatbot. But the moment
            you build that, a second question shows up and won&apos;t leave: how
            do you keep the operator (me) honest? Finlynq runs on a single VPS I
            own. If I wanted to read your transactions, what would actually stop
            me?
          </p>

          <p>
            The answer is{" "}
            <strong>per-user envelope encryption with a key derived from your password</strong>
            . It has real teeth. It also has real limits, and I&apos;d rather
            you hear about both from me. So both are in this post.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            1. The threat model, or what we are and aren&apos;t protecting
            against
          </h2>

          <p>
            Encryption only means something if you say what it&apos;s protecting
            against. So here are the threats Finlynq&apos;s design actually takes
            seriously:
          </p>

          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              <strong>Stolen database dump.</strong> Someone gets read access to
              the Postgres database. A disk image, a pg_dump, an unauthorized
              backup copy, whatever. They should not be able to read your
              merchant names, account names, notes, tags, or categories from
              that dump alone.
            </li>
            <li>
              <strong>Stolen database <em>and</em> server filesystem.</strong>{" "}
              Now an attacker has the DB plus the server&apos;s environment
              variables. The pepper helps here (more on that below), but they
              would still have to brute-force every user&apos;s password one at a
              time. That&apos;s slow on purpose.
            </li>
            <li>
              <strong>Stale backups in cloud storage.</strong> Database backups
              are encrypted on disk with a symmetric key kept off the host. So a
              copy floating around some backup bucket isn&apos;t a breach by
              itself.
            </li>
            <li>
              <strong>Cross-tenant data leaks.</strong> One user&apos;s data
              should never become readable by another user. Not through a buggy
              import, not a backup restore, not an account wipe.
            </li>
          </ul>

          <p>
            And here are the threats Finlynq does <em>not</em> claim to defend
            against. You should know these before you trust the system:
          </p>

          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              <strong>A malicious or compromised operator at runtime.</strong>{" "}
              When you&apos;re signed in, your decryption key is sitting in the
              server&apos;s memory. An attacker who roots the box while
              you&apos;re using it can read it. I&apos;m not going to pretend
              there&apos;s a clean way around this for a web app that answers
              your queries server-side. Only a true client-side-only design
              dodges it, and that comes with its own pile of compromises (no
              server-side aggregation, no MCP, no AI assistant access).
            </li>
            <li>
              <strong>The amounts and dates of your transactions.</strong> These
              live in the database as plain numbers and dates. They have to.
              Otherwise the app couldn&apos;t sum your spending, build a budget,
              or hand an AI a portfolio analysis without your browser doing all
              the math. So the operator can see anonymized amounts and dates.
              They&apos;re useless without the labels, but they&apos;re not
              encrypted, and I&apos;m not going to dress that up.
            </li>
            <li>
              <strong>The structure of your data.</strong> The fact that you
              have 14 accounts, 320 transactions a month, and a 7.4% savings
              rate is visible to the operator. Just not <em>what</em> any of it
              is for.
            </li>
            <li>
              <strong>Side-channel inference.</strong> If your &ldquo;Account
              #3&rdquo; has a recurring $1,847.00 charge on the 15th of every
              month, and you live in a big city, a determined operator could
              guess &ldquo;that&apos;s probably rent.&rdquo; Encryption
              doesn&apos;t stop guesses. It stops <em>reading</em>.
            </li>
            <li>
              <strong>A subpoena.</strong> Operators get subpoenaed. Finlynq is
              run from Canada and we have a privacy policy with retention rules,
              but a court order is a court order. What we could be forced to hand
              over is the encrypted data plus whatever metadata the database
              holds. Without your password, even we can&apos;t read the labels.
            </li>
          </ul>

          <p>
            If anything in that second list is a dealbreaker for you,
            self-hosting is the right answer. Finlynq is AGPL v3, so the exact
            same code runs on your laptop or homelab as on our managed cloud.
            The full self-hosting guide is at{" "}
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
              A <strong>Data Encryption Key</strong> (DEK). 32 random bytes, one
              per user, generated the moment you sign up. This is the key that
              actually encrypts your fields.
            </li>
            <li>
              A <strong>Key Encryption Key</strong> (KEK). Derived fresh from
              your password every time you sign in. Its only job is to wrap and
              unwrap the DEK.
            </li>
          </ol>

          <p>
            The DEK never leaves the server, but it&apos;s only useful once
            it&apos;s unwrapped, and unwrapping it takes your password.
            Here&apos;s the sequence in a bit more detail.
          </p>

          <p>
            <strong>When you sign up:</strong>
          </p>
          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              Finlynq generates a fresh, random 32-byte DEK straight from the OS
              random source.
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
              <code>N = 2<sup>16</sup>, r = 8, p = 1</code>. That&apos;s roughly
              64 MB of memory and around 80 ms of compute per derivation on
              modern hardware. The result is the KEK.
            </li>
            <li>
              The DEK gets wrapped (encrypted) with the KEK using AES-256-GCM,
              and the wrapped DEK plus the salt go into your{" "}
              <code>users</code> row.
            </li>
            <li>
              The raw KEK is thrown away the instant the wrap finishes. So now
              the database holds a wrapped DEK and a salt, and nothing on the
              server can unwrap that DEK without your password. Nothing.
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
              It uses that KEK to unwrap your DEK and caches the raw DEK in
              memory, keyed by your session id.
            </li>
            <li>
              The KEK gets discarded again, right away. The cache holds only the
              DEK, and only for the life of your session, with a sliding 2-hour
              idle timeout. Walk away from your laptop for the afternoon and your
              DEK is already gone from memory by the time you come back. The next
              request decrypts nothing until you sign in again.
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
              That{" "}
              <code>v1:</code> prefix is just a version marker, so we can rotate
              schemes down the road without any guesswork.
            </li>
            <li>
              GCM is an <em>authenticated</em> encryption mode. Every row carries
              a 16-byte authentication tag that gets checked on decrypt. Flip a
              single bit of the ciphertext and decryption fails loudly, instead
              of quietly handing back wrong plaintext.
            </li>
            <li>
              A random IV per row means even if two transactions have the exact
              same payee name, their ciphertexts look nothing alike. The operator
              can&apos;t even tell that &ldquo;you shop at the same place
              twice.&rdquo;
            </li>
          </ul>

          <p>
            One more detail worth calling out. The password fed into scrypt
            isn&apos;t the raw password. It&apos;s{" "}
            <code>HMAC-SHA256(server-pepper, password)</code>, where the pepper
            is a long random secret that lives in the server&apos;s environment
            and never touches the database. The whole point of the pepper is to
            blunt a database-only leak: even a stolen DB plus a 1080 Ti
            can&apos;t mount an offline scrypt-cracking run without also lifting
            the pepper out of the server&apos;s environment. It&apos;s not a
            user-facing thing, and losing it is the same as losing the DB. But it
            raises the bar against database-only theft, which is by far the most
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
            . It&apos;s about 280 lines, comments and all. AGPL v3, so go read it
            yourself. Please do.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            3. What this means in practice
          </h2>

          <p>
            Here&apos;s exactly what the operator (me) can and can&apos;t see
            when I open a psql shell against the production database:
          </p>

          <p>
            <strong>What I cannot decrypt:</strong>
          </p>
          <ul className="list-disc pl-6 space-y-1.5">
            <li>The payee on any transaction.</li>
            <li>The free-text note on any transaction or split.</li>
            <li>The tags on any transaction.</li>
            <li>
              The display names of your accounts, categories, goals, loans,
              subscriptions, and portfolio holdings. These were the last
              plaintext labels left in the database, and they got physically
              dropped from the schema on 2026-05-03 in a project we called
              Stream D Phase 4. The plaintext columns are gone now. Only the
              encrypted versions remain.
            </li>
            <li>
              The encrypted attachment of any receipt you upload to the file
              store.
            </li>
            <li>The aliases you gave your accounts.</li>
          </ul>

          <p>
            <strong>What I can see:</strong>
          </p>
          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              The numeric amount of every transaction, and the currency code.
            </li>
            <li>
              The transaction date, plus the date the row was created or last
              updated.
            </li>
            <li>
              The integer foreign keys that tie a transaction to an
              (encrypted-name) account and an (encrypted-name) category.
            </li>
            <li>
              Whether a row is a regular transaction, a transfer, an income, or
              an expense. That one-character{" "}
              <code>type</code> column (<code>E</code> / <code>I</code> /{" "}
              <code>R</code> / <code>T</code>) stays plaintext, because the
              category-vs-sign invariant has to be checked server-side.
            </li>
            <li>
              How many accounts, categories, goals, and holdings you have, and
              the overall shape of your portfolio (counts, dates, integer IDs).
            </li>
          </ul>

          <p>
            Put another way: I can see &ldquo;there&apos;s a $42.18 expense on
            2026-04-09 in category #14, account #3.&rdquo; I can&apos;t see what
            category #14 is, what account #3 is, who the payee was, or what note
            you scribbled on it. The amounts and dates are visible. The labels
            are not.
          </p>

          <p>
            This is the honest version of the privacy claim. The landing page
            says &ldquo;Mathematically private,&rdquo; and that&apos;s true{" "}
            <em>about the labels</em>. They really are sealed by a key derived
            from your password. But it overstates things if you read it as
            &ldquo;the operator sees nothing.&rdquo; The operator sees plenty.
            The operator just can&apos;t read the labels that turn those numbers
            into anything meaningful about your life.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            4. The honest tradeoffs
          </h2>

          <p>
            Three tradeoffs I want to be flat-out about.
          </p>

          <p>
            <strong>Tradeoff 1: lose your password, lose your data.</strong>{" "}
            Finlynq has no recovery key, no admin override, no master decryption
            key sitting on ice for emergencies. If you forget your password, the
            &ldquo;reset&rdquo; flow does the only thing it cryptographically
            can: it wipes all your data and hands you a fresh DEK under your new
            password. There&apos;s no calling support to recover what was in
            there. And that&apos;s on purpose. Any recovery mechanism would mean
            Finlynq is holding something that can decrypt your data, which is the
            exact thing we&apos;re promising isn&apos;t true.
          </p>

          <p>
            This is a real cost. People forget passwords, it happens. The fix is
            simple, if boring: pick a password from a password manager, write it
            down somewhere physically safe, and now and then export an
            unencrypted JSON backup to your own machine (Settings → Data →
            Export). Finlynq can&apos;t save you from losing your password. But
            you can save yourself.
          </p>

          <p>
            <strong>Tradeoff 2: amounts and dates aren&apos;t encrypted.</strong>{" "}
            Some personal-finance apps encrypt the amounts too and do all the
            aggregation in the browser. That&apos;s a defensible design. It does
            shrink what the operator can see. But it also makes the things
            Finlynq cares most about (server-side MCP tools, aggregate queries
            from an AI, multi-currency conversion, the FIRE calculator) either
            impossible or painfully slow. So I made the call: an AI being able to
            answer &ldquo;what was my total spend last month?&rdquo; server-side
            is worth more than the slim privacy gain of hiding un-labelled
            amounts from the operator.
          </p>

          <p>
            If you disagree with that call, and reasonable people do, the answer
            is self-hosting. When you self-host, &ldquo;the operator sees the
            amounts&rdquo; quietly becomes &ldquo;you see the amounts,&rdquo;
            which is presumably fine.
          </p>

          <p>
            <strong>Tradeoff 3: deploys briefly degrade the read path.</strong>{" "}
            The DEK cache lives in process memory, so whenever Finlynq restarts
            (a deploy, a crash, a maintenance window) every signed-in user
            suddenly has a valid session cookie but no cached DEK on the server.
            Instead of 503ing every page until everyone logs back in, the read
            paths handle it gracefully: encrypted fields render as a placeholder,
            the app keeps working, and your next sign-in puts everything back to
            normal. Writes that need the key block until you re-sign-in, because
            silently writing plaintext into encrypted columns would be a lot
            worse than blocking. There&apos;s also a deploy-generation marker
            that proactively kills old sessions across a deploy boundary, so you
            get a clean re-auth instead of a half-broken one.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            5. Why this matters for the AI-in-finance question
          </h2>

          <p>
            Finlynq&apos;s pitch is &ldquo;track your money here, analyze it
            anywhere.&rdquo; The &ldquo;anywhere&rdquo; part is the{" "}
            <a
              href="https://modelcontextprotocol.io"
              className="underline underline-offset-2 hover:text-primary"
            >
              Model Context Protocol
            </a>{" "}
            server, with 109 HTTP tools (93 over stdio) that let Claude, ChatGPT,
            Cursor, or any other MCP-compatible AI assistant query and change
            your financial data on your behalf.
          </p>

          <p>
            The encryption model matters here because of the one question every
            cautious person asks before they wire an AI up to their bank data:{" "}
            <em>where does the data actually go, and who gets to see it?</em>
          </p>

          <p>
            For Finlynq, the answer comes in layers:
          </p>

          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              Your <strong>raw data</strong> lives in Finlynq&apos;s database,
              with the labels encrypted at rest, exactly as described above.
            </li>
            <li>
              When an AI assistant calls an MCP tool, it authenticates with
              either OAuth 2.1, a Bearer API key, or stdio. The server unwraps
              your DEK for that request, decrypts only what the tool actually
              needs to return, and the tool&apos;s response heads back to the AI
              as plaintext JSON. The AI provider (Anthropic, OpenAI, whoever)
              does see that response. There&apos;s no way around it if you want
              the AI to answer questions about your data.
            </li>
            <li>
              That MCP session is <em>scoped</em>. It gets read-only or
              read-write tools based on the OAuth scope you granted, you can
              revoke the grant from Settings → Connected apps whenever you like,
              and destructive operations need a preview-then-confirm
              cryptographic token, so the AI can&apos;t change your data without
              you taking an explicit step.
            </li>
            <li>
              We don&apos;t train models on your data. The MCP server is a tool
              gateway, not an ingest pipeline. Anything that crosses the AI
              vendor&apos;s API is governed by <em>their</em> privacy policy, so
              check{" "}
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
              for the specifics. But the link between your data and that vendor
              is one you explicitly turn on, and can turn off.
            </li>
          </ul>

          <p>
            So if you&apos;re nervous about AI assistants reaching into your
            financial life, the answer isn&apos;t &ldquo;never grant the
            access.&rdquo; The useful answer is &ldquo;grant a scoped, revocable,
            observable session, and run it on a backend that can&apos;t read the
            data on its own.&rdquo; That second half is the part the encryption
            model buys you.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            6. Where to learn more
          </h2>

          <p>
            Everything in this post is spelled out in more rigorous detail in
            the architecture docs, and the code behind it is published under
            AGPL v3:
          </p>

          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              <a
                href="https://github.com/finlynq/finlynq/blob/main/pf-app/docs/architecture/encryption.md"
                className="underline underline-offset-2 hover:text-primary"
              >
                <code>pf-app/docs/architecture/encryption.md</code>
              </a>{" "}
              is the authoritative technical reference. It covers Phase 2, Phase
              3, and the Stream D rollout that finally encrypted display names,
              plus the auth-tag failure resilience helper that headed off a whole
              class of regressions, the wipe-account primitive, the
              backup-restore foreign-key remap, and the grace migration for
              pre-encryption accounts.
            </li>
            <li>
              <a
                href="https://github.com/finlynq/finlynq/tree/main/pf-app/src/lib/crypto"
                className="underline underline-offset-2 hover:text-primary"
              >
                <code>pf-app/src/lib/crypto/</code>
              </a>{" "}
              is the implementation. Roughly 1,500 lines across envelope, key
              cache, column helpers, staging envelope, and file envelope. Small
              enough to read in an afternoon.
            </li>
            <li>
              <a
                href="https://github.com/finlynq/finlynq/blob/main/STREAM_D.md"
                className="underline underline-offset-2 hover:text-primary"
              >
                <code>STREAM_D.md</code>
              </a>{" "}
              is the design doc for the display-name encryption rollout. Worth a
              look if you want to understand the parallel{" "}
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
              is the policy version of all of this, with GDPR Article 30 records,
              retention rules, and the sub-processor list.
            </li>
            <li>
              <Link
                href="/self-hosted"
                className="underline underline-offset-2 hover:text-primary"
              >
                /self-hosted
              </Link>
              . If the &ldquo;trust the operator&rdquo; layer is the part
              you&apos;d rather skip, run Finlynq on your own hardware. Same code,
              same encryption, except now you&apos;re the operator.
            </li>
          </ul>

          <p>
            And if you spot something in the design or the code that&apos;s
            wrong, or just weaker than this post claims, please tell me. Email{" "}
            <code>privacy@finlynq.com</code>, or open an issue at{" "}
            <a
              href="https://github.com/finlynq/finlynq/issues"
              className="underline underline-offset-2 hover:text-primary"
            >
              github.com/finlynq/finlynq/issues
            </a>
            . An honest threat model beats a confident one every time, and the
            only way it stays honest is if people who know more than I do keep
            poking holes in it.
          </p>

          <p className="mt-12 text-xs text-muted-foreground">
            Hussein Halawi, founder · 2026-05-13. Corrections welcome.
          </p>
        </article>
      </div>
    </div>
  );
}
