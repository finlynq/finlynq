import Link from "next/link";
import type { Metadata } from "next";
import { AnalyticsConsent } from "@/components/analytics-consent";
import { StoreBadges } from "@/components/store-badges";
import {
  JsonLd,
  articleSchema,
  breadcrumbSchema,
} from "@/components/seo/json-ld";

const SLUG = "finlynq-mobile-app";
const PUBLISHED = "2026-06-01";

export const metadata: Metadata = {
  title: "Finlynq is now on iOS and Android",
  description:
    "Finlynq's native mobile app is on the App Store and Google Play. Check balances, budgets, portfolio, and net worth, add transactions, and import on the go.",
  alternates: { canonical: `/blog/${SLUG}` },
  openGraph: {
    title: "Finlynq is now on iOS and Android",
    description:
      "A native companion app for the open-source, MCP-first personal finance app, now on the App Store and Google Play.",
    type: "article",
    url: `/blog/${SLUG}`,
    siteName: "Finlynq",
  },
  twitter: {
    card: "summary_large_image",
    title: "Finlynq is now on iOS and Android",
    description:
      "On the App Store and Google Play now. Same data, same encryption, now in your pocket.",
  },
};

export default function FinlynqMobileAppPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <AnalyticsConsent />
      <JsonLd
        data={articleSchema({
          title: "Finlynq is now on iOS and Android",
          description:
            "Finlynq's native mobile app is available now on the App Store and Google Play.",
          path: `/blog/${SLUG}`,
          datePublished: PUBLISHED,
        })}
      />
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Blog", path: "/blog" },
          { name: "Finlynq is now on iOS and Android", path: `/blog/${SLUG}` },
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
            Finlynq is now on iOS and Android
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            A native companion app for your money · Published 2026-06-01 ·
            Updated 2026-06-24
          </p>
        </header>

        <article className="prose prose-invert max-w-none space-y-6 text-[15px] leading-relaxed">
          <p className="text-base">
            Finlynq has always been two things: a web app where you track your
            money, and an MCP server that lets your AI assistant dig into it. The
            catch was that the moment you stepped away from your desk, you had to
            open a browser. Not anymore. Finlynq now has a real native app, and
            it is live today on both the App Store and Google Play.
          </p>

          <StoreBadges className="not-prose" />

          <h2 className="text-xl font-semibold mt-12 mb-3">
            What you can do in the app
          </h2>

          <p>
            The mobile app is a true companion to the web app, not a watered-down
            viewer. It talks to the same Finlynq backend over HTTPS, so
            everything you set up on the web is there on your phone the moment
            you sign in. On day one you can:
          </p>

          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              See your <strong>net worth and a dashboard</strong> of recent
              activity at a glance.
            </li>
            <li>
              Browse <strong>accounts and balances</strong>, with each
              account&apos;s native currency shown alongside your display
              currency.
            </li>
            <li>
              Review <strong>transactions</strong>, <strong>budgets</strong>{" "}
              with progress, your <strong>investment portfolio</strong> and
              holdings, and your <strong>savings goals</strong>.
            </li>
            <li>
              <strong>Add transactions, accounts, categories, and goals</strong>{" "}
              on the go, so you can log a purchase the moment it happens.
            </li>
            <li>
              <strong>Import statements</strong> straight from your phone by
              picking a CSV or PDF file.
            </li>
            <li>
              Switch between <strong>light, dark, and system themes</strong>,
              read announcements, and send feedback right from the app.
            </li>
          </ul>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            The same privacy model as the web
          </h2>

          <p>
            The mobile app does not change how your data is protected. Your
            sensitive labels (merchant names, account names, notes, tags,
            category names) stay encrypted at rest with a key derived from your
            password, exactly as they are on the web. The phone is a client; it
            signs in over HTTPS and the server decrypts only what a screen needs
            to show you. If you want the full walkthrough of how that works, it
            is in{" "}
            <Link
              href="/blog/how-finlynq-encrypts-your-money"
              className="underline underline-offset-2 hover:text-primary"
            >
              How Finlynq encrypts your money
            </Link>
            .
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            Self-hosting? Point the app at your own instance
          </h2>

          <p>
            Finlynq is AGPL v3, and a lot of people run it on their own hardware.
            The mobile app has a server field, so you are not locked to the
            managed cloud: enter the URL of your self-hosted instance and the
            app connects there instead. Same app, your server, your data. The
            self-hosting guide lives at{" "}
            <Link
              href="/self-hosted"
              className="underline underline-offset-2 hover:text-primary"
            >
              /self-hosted
            </Link>
            .
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            Where things stand, and what is next
          </h2>

          <p>
            Both apps are live now: iOS on the App Store, Android on Google
            Play, built from a single React Native codebase. What comes next is
            not more platforms, it is depth. We are closing the last gaps with
            the web app, adding push notifications, and smoothing the rough edges
            that only show up once people use something every day. If you hit one
            of those, send feedback from inside the app. It comes straight to us.
          </p>

          <p>
            None of this changes the heart of Finlynq. The web app and the{" "}
            <Link
              href="/mcp-guide"
              className="underline underline-offset-2 hover:text-primary"
            >
              MCP server
            </Link>{" "}
            remain the core of how you track and analyze your money. The mobile
            app is about meeting you where you already are: in line at a store,
            on the couch, away from your laptop.
          </p>

          <h2 className="text-xl font-semibold mt-12 mb-3">
            Get the app
          </h2>

          <p>
            Download it now and sign in with your Finlynq account:
          </p>

          <StoreBadges className="not-prose" />

          <ul className="list-disc pl-6 space-y-1.5">
            <li>
              New to Finlynq? The cloud app is free, and there is a public demo
              at{" "}
              <Link
                href="/cloud"
                className="underline underline-offset-2 hover:text-primary"
              >
                /cloud
              </Link>
              .
            </li>
            <li>
              Star or watch the repo at{" "}
              <a
                href="https://github.com/finlynq/finlynq"
                className="underline underline-offset-2 hover:text-primary"
              >
                github.com/finlynq/finlynq
              </a>
              .
            </li>
            <li>
              Have a feature request for mobile? Open an issue at{" "}
              <a
                href="https://github.com/finlynq/finlynq/issues"
                className="underline underline-offset-2 hover:text-primary"
              >
                github.com/finlynq/finlynq/issues
              </a>
              , or send feedback from inside the app.
            </li>
          </ul>

          <p className="mt-12 text-xs text-muted-foreground">
            Hussein Halawi, founder · 2026-06-01.
          </p>
        </article>
      </div>
    </div>
  );
}
