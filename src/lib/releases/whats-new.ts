/**
 * Release notes on What's New for self-hosted installs (GH #471). Pure and
 * browser-safe: the running version, the list shown, and how a newer GitHub
 * release is recognised.
 *
 * The running version is the newest entry in RELEASES (src/lib/seo/releases.ts)
 * at build time: that file ships with the code, so an install built from
 * v3.7.0 carries v3.7.0 as its newest entry.
 */
import type { Release } from "@/lib/seo/releases";

export type WhatsNewRelease = Pick<Release, "version" | "slug" | "name" | "date" | "tagline" | "sections" | "githubUrl">;

export type LatestRelease = { version: string; url: string; publishedAt: string | null };

/** Compare dotted numeric versions ("3.10.0" > "3.9.2"); a leading "v" is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .trim()
      .replace(/^v/i, "")
      .split(/[.+-]/)
      .slice(0, 3)
      .map((p) => (/^\d+$/.test(p) ? Number(p) : 0));
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** The release this build is running: the newest version in the list. */
export function runningRelease<T extends Pick<Release, "version">>(releases: readonly T[]): T | null {
  let best: T | null = null;
  for (const r of releases) if (!best || compareVersions(r.version, best.version) > 0) best = r;
  return best;
}

/** Newest first, trimmed to what the page shows. */
export function releasesForWhatsNew(releases: readonly Release[], limit = 10): WhatsNewRelease[] {
  return [...releases]
    .sort((a, b) => compareVersions(b.version, a.version))
    .slice(0, limit)
    .map(({ version, slug, name, date, tagline, sections, githubUrl }) => ({ version, slug, name, date, tagline, sections, githubUrl }));
}

/**
 * GitHub's `GET /repos/<o>/<r>/releases/latest` body → the latest release, or
 * null when it isn't one we can read (that endpoint never returns drafts or
 * prereleases, but check anyway).
 */
export function parseLatestRelease(body: unknown): LatestRelease | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.draft === true || b.prerelease === true) return null;
  const tag = typeof b.tag_name === "string" ? b.tag_name.trim() : "";
  const version = tag.replace(/^v/i, "");
  if (!/^\d+\.\d+(\.\d+)?$/.test(version)) return null;
  const url =
    typeof b.html_url === "string" && b.html_url.startsWith("https://github.com/")
      ? b.html_url
      : `https://github.com/finlynq/finlynq/releases/tag/${tag}`;
  return { version, url, publishedAt: typeof b.published_at === "string" ? b.published_at : null };
}

/** A newer release than the one running, or null. */
export function updateAvailable(running: string | null, latest: LatestRelease | null): LatestRelease | null {
  if (!running || !latest) return null;
  return compareVersions(latest.version, running) > 0 ? latest : null;
}

/** This browser's "seen" marker: the running release shows New until it is seen once. */
export const SEEN_RELEASE_KEY = "pf-whats-new-seen-release";
