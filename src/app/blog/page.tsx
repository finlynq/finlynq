import Link from "next/link";
import type { Metadata } from "next";
import { AnalyticsConsent } from "@/components/analytics-consent";

export const metadata: Metadata = {
  title: "Blog · Finlynq",
  description:
    "Long-form writing about the Finlynq personal-finance app: encryption architecture, MCP design, AI in personal finance, and what it's like running an open-source app.",
  alternates: { canonical: "/blog" },
  openGraph: {
    title: "Finlynq blog",
    description:
      "Long-form writing on encryption, MCP design, and running an open-source personal-finance app.",
    url: "/blog",
    type: "website",
    siteName: "Finlynq",
  },
  twitter: {
    card: "summary_large_image",
    title: "Finlynq blog",
    description:
      "Encryption architecture, MCP design, and open-source personal-finance operations.",
  },
};

type Post = {
  slug: string;
  title: string;
  blurb: string;
  date: string;
};

const POSTS: Post[] = [
  {
    slug: "finlynq-mobile-app",
    title: "Finlynq is now on iOS and Android",
    blurb:
      "The native app is finally here, on the App Store and Google Play. Check your balances, budgets, portfolio, and net worth from your phone. Add transactions, import statements, the works. Same encryption as the web app, no shortcuts. And if you self-host, just point it at your own instance.",
    date: "2026-06-01",
  },
  {
    slug: "how-finlynq-encrypts-your-money",
    title: "How Finlynq encrypts your money",
    blurb:
      "Envelope encryption, explained like a human would. AES-256-GCM, a scrypt-derived key from your password, a DEK per user, and the tradeoffs I'm not going to pretend away (the operator can still see anonymized amounts, and if you lose your password, your data is gone).",
    date: "2026-05-13",
  },
];

export default function BlogIndexPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <AnalyticsConsent />
      <div className="mx-auto max-w-3xl px-6 py-16">
        <header className="mb-12 border-b border-border pb-8">
          <Link
            href="/"
            className="text-xs font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            ← Finlynq
          </Link>
          <h1 className="mt-4 text-4xl font-bold tracking-tight">Blog</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Longer pieces on encryption, MCP design, and what it&apos;s
            actually like to run an open-source personal-finance app.
          </p>
        </header>

        <section className="space-y-10">
          {POSTS.map((post) => (
            <article
              key={post.slug}
              className="border-b border-border pb-10 last:border-b-0"
            >
              <h2 className="text-2xl font-semibold tracking-tight">
                <Link
                  href={`/blog/${post.slug}`}
                  className="hover:text-primary"
                >
                  {post.title}
                </Link>
              </h2>
              <p className="mt-2 text-xs font-mono uppercase tracking-wider text-muted-foreground">
                {post.date}
              </p>
              <p className="mt-4 text-[15px] leading-relaxed text-foreground/90">
                {post.blurb}
              </p>
              <p className="mt-4">
                <Link
                  href={`/blog/${post.slug}`}
                  className="text-sm underline underline-offset-2 hover:text-primary"
                >
                  Read more →
                </Link>
              </p>
            </article>
          ))}
        </section>
      </div>
    </div>
  );
}
