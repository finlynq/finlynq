/**
 * GH #471: What's New shows Finlynq's release notes on SELF-HOSTED installs
 * (nobody posts announcements there), with the running version and a newer
 * GitHub release when there is one. Finlynq's hosted service is unchanged.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { isFinlynqCloud, isSelfHosted } from "@/lib/deployment";
import {
  compareVersions,
  parseLatestRelease,
  releasesForWhatsNew,
  runningRelease,
  updateAvailable,
} from "@/lib/releases/whats-new";
import { _resetLatestReleaseCache, getLatestRelease, updateCheckEnabled } from "@/lib/releases/update-check";
import { RELEASES } from "@/lib/seo/releases";

describe("hosted or self-hosted", () => {
  it("finlynq.com and its subdomains are the hosted service", () => {
    expect(isFinlynqCloud({ APP_URL: "https://finlynq.com" })).toBe(true);
    expect(isFinlynqCloud({ APP_URL: "https://dev.finlynq.com" })).toBe(true);
    expect(isSelfHosted({ APP_URL: "https://finlynq.com" })).toBe(false);
  });

  it("anything else is self-hosted, including a look-alike domain and no APP_URL", () => {
    expect(isSelfHosted({ APP_URL: "http://localhost:3000" })).toBe(true);
    expect(isSelfHosted({ APP_URL: "https://money.example.org" })).toBe(true);
    expect(isSelfHosted({ APP_URL: "https://notfinlynq.com" })).toBe(true);
    expect(isSelfHosted({})).toBe(true);
  });

  it("PF_CLOUD wins over APP_URL either way", () => {
    expect(isFinlynqCloud({ PF_CLOUD: "1", APP_URL: "http://localhost:3000" })).toBe(true);
    expect(isFinlynqCloud({ PF_CLOUD: "false", APP_URL: "https://finlynq.com" })).toBe(false);
  });
});

describe("versions", () => {
  it("compares numerically, ignoring a leading v", () => {
    expect(compareVersions("3.10.0", "3.9.2")).toBe(1);
    expect(compareVersions("v3.7.0", "3.7.0")).toBe(0);
    expect(compareVersions("3.7", "3.7.1")).toBe(-1);
  });

  it("the running release is the newest in the build, and the list is newest first", () => {
    const running = runningRelease(RELEASES);
    expect(running?.current).toBe(true);
    const list = releasesForWhatsNew(RELEASES, 3);
    expect(list).toHaveLength(3);
    expect(list[0].version).toBe(running?.version);
    expect(compareVersions(list[0].version, list[1].version)).toBe(1);
    expect(Object.keys(list[0]).sort()).toEqual(["date", "githubUrl", "name", "sections", "slug", "tagline", "version"]);
  });

  it("reads GitHub's latest release and only offers a newer one", () => {
    const latest = parseLatestRelease({ tag_name: "v3.8.0", html_url: "https://github.com/finlynq/finlynq/releases/tag/v3.8.0", published_at: "2026-12-01T10:00:00Z" });
    expect(latest).toEqual({ version: "3.8.0", url: "https://github.com/finlynq/finlynq/releases/tag/v3.8.0", publishedAt: "2026-12-01T10:00:00Z" });
    expect(updateAvailable("3.7.0", latest)?.version).toBe("3.8.0");
    expect(updateAvailable("3.8.0", latest)).toBeNull();
    expect(updateAvailable("3.9.0", latest)).toBeNull();
    expect(updateAvailable(null, latest)).toBeNull();
  });

  it("ignores drafts, prereleases, odd tags and a link off GitHub", () => {
    expect(parseLatestRelease({ tag_name: "v3.8.0", prerelease: true })).toBeNull();
    expect(parseLatestRelease({ tag_name: "nightly" })).toBeNull();
    expect(parseLatestRelease(null)).toBeNull();
    expect(parseLatestRelease({ tag_name: "v3.8.0", html_url: "https://evil.example/x" })?.url).toBe(
      "https://github.com/finlynq/finlynq/releases/tag/v3.8.0",
    );
  });
});

describe("update check", () => {
  beforeEach(() => _resetLatestReleaseCache());

  it("PF_UPDATE_CHECK=false turns it off", () => {
    expect(updateCheckEnabled({})).toBe(true);
    expect(updateCheckEnabled({ PF_UPDATE_CHECK: "false" })).toBe(false);
    expect(updateCheckEnabled({ PF_UPDATE_CHECK: "off" })).toBe(false);
  });

  it("asks GitHub once and reuses the answer for 6 hours", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ tag_name: "v9.0.0" }), { status: 200 }));
    const t0 = 1_000_000;
    expect((await getLatestRelease(t0, fetcher as unknown as typeof fetch))?.version).toBe("9.0.0");
    await getLatestRelease(t0 + 60_000, fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await getLatestRelease(t0 + 7 * 3600_000, fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("a failure is null, never a throw, and retries after an hour", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await getLatestRelease(0, fetcher as unknown as typeof fetch)).toBeNull();
    await getLatestRelease(30 * 60_000, fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await getLatestRelease(61 * 60_000, fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("wiring", () => {
  it("the route answers only selfHosted:false on the hosted service and respects the switch", () => {
    const route = readFileSync("src/app/api/whats-new/releases/route.ts", "utf8");
    expect(route).toMatch(/if \(!isSelfHosted\(\)\) return \{ selfHosted: false as const \}/);
    expect(route).toMatch(/check \? updateAvailable\(running, await getLatestRelease\(\)\) : null/);
    expect(route).toMatch(/apiHandler\(\{ auth: "auth" \}/);
  });

  it("the page reads the route and keeps the announcements", () => {
    const page = readFileSync("src/app/(app)/whats-new/page.tsx", "utf8");
    expect(page).toMatch(/fetch\("\/api\/whats-new\/releases"\)/);
    expect(page).toMatch(/fetch\("\/api\/announcements"\)/);
    expect(page).toMatch(/You&apos;re on v/);
  });
});
