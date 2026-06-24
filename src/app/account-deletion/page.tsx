import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Delete your Finlynq account & data | Finlynq",
  description:
    "How to delete your Finlynq account and associated data, what gets removed, what is briefly retained, and how to request deletion by email.",
  alternates: { canonical: "/account-deletion" },
  openGraph: {
    title: "Delete your Finlynq account & data | Finlynq",
    description:
      "How to delete your Finlynq account and associated data, what gets removed, what is briefly retained, and how to request deletion by email.",
    url: "/account-deletion",
    type: "website",
    siteName: "Finlynq",
  },
};

export default function AccountDeletionPage() {
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
          <h1 className="mt-4 text-4xl font-bold tracking-tight">
            Delete your Finlynq account &amp; data
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">Last updated: 2026-05-30</p>
        </header>

        <section className="prose prose-invert max-w-none space-y-8 text-[15px] leading-relaxed">
          <p className="text-base">
            This page explains how to delete your <strong>Finlynq</strong> account
            (the Finlynq personal-finance app, developer Finlynq) and all of the
            data tied to it. You can do this yourself at any time, with no request
            to us needed, or you can ask us to do it for you.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            Option 1: delete it yourself (recommended, immediate)
          </h2>
          <p>
            You delete your account from the Finlynq web app. It applies to your
            whole account, whether or not you also use the Android app.
          </p>
          <ol className="list-decimal pl-6 space-y-1.5">
            <li>
              Open <a className="underline underline-offset-2 hover:text-primary" href="https://finlynq.com">finlynq.com</a>{" "}
              in a browser and sign in with your username (or email) and password.
            </li>
            <li>
              Go to <code>Settings → Data</code>.
            </li>
            <li>
              Click <code>Delete account</code>.
            </li>
            <li>
              Confirm when prompted. The deletion runs immediately and cannot be
              undone.
            </li>
          </ol>
          <p>
            Tip: before deleting, you can download a full copy of your data from{" "}
            <code>Settings → Data → Export</code> (a JSON backup).
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            Option 2: ask us to delete it
          </h2>
          <p>
            If you can&apos;t sign in, email{" "}
            <a
              className="underline underline-offset-2 hover:text-primary"
              href="mailto:privacy@finlynq.com?subject=Account%20deletion%20request"
            >
              privacy@finlynq.com
            </a>{" "}
            from the email address on your account (or include your username) and
            ask us to delete your account. We&apos;ll verify ownership and finish
            the deletion within 30 days.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            Delete some data without deleting your account
          </h2>
          <p>
            You don&apos;t have to delete your whole account to remove data. From{" "}
            <code>Settings → Data</code> (and throughout the app) you can delete
            individual accounts, transactions, budgets, investments, goals, loans,
            and uploaded files, or export everything first. These changes take
            effect right away.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">What gets deleted</h2>
          <p>
            Deleting your account removes <strong>every record scoped to your
            account</strong>, in a single database transaction. This includes:
          </p>
          <ul className="list-disc pl-6 space-y-1.5">
            <li>Your account identity: username, email, and password hash.</li>
            <li>
              All financial data you entered or imported: accounts, transactions,
              budgets, investments and holdings, loans, goals, categories, rules,
              and any uploaded statement files / attached receipts.
            </li>
            <li>
              MCP / API tokens and any connected-app (OAuth) grants you created.
            </li>
          </ul>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            What is briefly retained, and for how long
          </h2>
          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              <strong>Operational logs</strong> (IP address, user agent, URL path,
              status code) are retained for <strong>30 days</strong> for abuse
              prevention and debugging, then automatically rotated/deleted.
            </li>
            <li>
              <strong>Encrypted database backups</strong> are retained for{" "}
              <strong>7 days</strong>. After 7 days your deleted data is no longer
              recoverable from backups.
            </li>
          </ul>
          <p>
            Once these windows pass, no copy of your account data remains.
          </p>

          <p className="mt-12 text-xs text-muted-foreground">
            See also our{" "}
            <Link href="/privacy" className="underline underline-offset-2 hover:text-primary">
              Privacy Policy
            </Link>{" "}
            for full details on what we collect, how it is encrypted, and your
            other rights. Questions:{" "}
            <code>privacy@finlynq.com</code>.
          </p>
        </section>
      </div>
    </div>
  );
}
