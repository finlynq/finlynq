import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Blog — Finlynq",
  description:
    "Long-form writing about the Finlynq personal-finance app: encryption architecture, MCP design, AI in personal finance, open-source operations.",
};

type Post = {
  slug: string;
  title: string;
  blurb: string;
  date: string;
};

const POSTS: Post[] = [
  {
    slug: "how-finlynq-encrypts-your-money",
    title: "How Finlynq encrypts your money",
    blurb:
      "Envelope encryption, in plain English. AES-256-GCM, a scrypt-derived key from your password, a per-user DEK, and the honest tradeoffs (operator can see anonymized amounts; lose your password, lose your data).",
    date: "2026-05-13",
  },
];

export default function BlogIndexPage() {
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
          <h1 className="mt-4 text-4xl font-bold tracking-tight">Blog</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Long-form writing on encryption, MCP design, and running an
            open-source personal-finance app.
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
