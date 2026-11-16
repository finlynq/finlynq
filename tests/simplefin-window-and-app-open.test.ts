/**
 * SimpleFIN sync window + auto-sync on app open (2026-11-15, in-app feedback #29).
 *
 * 1. We asked SimpleFIN for 90 days on every sync, and it answers that with
 *    "Requested date range exceeds limit of 90 days and was capped.", so every
 *    sync reported one problem and a real one (a bank connection that needs a
 *    new sign-in) looked the same. Measured on SimpleFIN's developer demo: 44
 *    days is clean, 45 to 89 days warn, 90 is capped. The window is now 44 days,
 *    89 on a first sync or after a long gap, and the range notice is never
 *    counted as a problem.
 * 2. The 12h auto-sync ran only from the login route, and the apps keep people
 *    signed in, so a user pressed Sync now on the website every day. Opening the
 *    app (GET /api/auth/session) now offers the same throttled sync.
 *
 * The static half pins the wiring, because a rule's own unit tests pass
 * whether or not anything calls it.
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { readFileSync } from "node:fs";
import {
  APP_OPEN_CHECK_INTERVAL_MS,
  SIMPLEFIN_MAX_WINDOW_DAYS,
  SIMPLEFIN_OVERLAP_DAYS,
  SIMPLEFIN_RECOMMENDED_WINDOW_DAYS,
  isSimplefinRangeNotice,
  lastFetchAt,
  simplefinWindowDays,
  takeAppOpenCheck,
} from "@/lib/external-import/simplefin-sync-status";

const ROOT = path.resolve(__dirname, "..");
/** Source with comments removed, so a comment can't satisfy a check. */
const code = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-11-15T12:00:00.000Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * DAY).toISOString();

describe("simplefinWindowDays", () => {
  it("stays inside SimpleFIN's limits", () => {
    expect(SIMPLEFIN_RECOMMENDED_WINDOW_DAYS).toBe(44);
    expect(SIMPLEFIN_MAX_WINDOW_DAYS).toBe(89);
    expect(SIMPLEFIN_MAX_WINDOW_DAYS).toBeLessThan(90);
  });

  it("asks for as much as SimpleFIN keeps on a first sync or an unreadable stamp", () => {
    expect(simplefinWindowDays(null, now)).toBe(89);
    expect(simplefinWindowDays("not a date", now)).toBe(89);
  });

  it("asks for the recommended 44 days while the last fetch plus a week fits", () => {
    expect(simplefinWindowDays(daysAgo(0.5), now)).toBe(44);
    expect(simplefinWindowDays(daysAgo(30), now)).toBe(44);
    expect(simplefinWindowDays(daysAgo(44 - SIMPLEFIN_OVERLAP_DAYS), now)).toBe(44);
  });

  it("widens to 89 days after a gap the recommended window would not cover", () => {
    expect(simplefinWindowDays(daysAgo(37.5), now)).toBe(89);
    expect(simplefinWindowDays(daysAgo(60), now)).toBe(89);
  });

  it("treats a stamp in the future as just fetched", () => {
    expect(simplefinWindowDays(daysAgo(-2), now)).toBe(44);
  });
});

describe("lastFetchAt", () => {
  const at = "2026-11-14T08:00:00.000Z";
  it("uses a sync that fetched, cleanly or with per-account problems", () => {
    expect(lastFetchAt({ ok: true, partial: false, trigger: "auto", at })).toBe(at);
    expect(lastFetchAt({ ok: false, partial: true, trigger: "manual", at, message: "1 problem" })).toBe(at);
  });
  it("ignores a sync that failed before fetching, and no status at all", () => {
    expect(lastFetchAt({ ok: false, partial: false, trigger: "auto", at, message: "x" })).toBeNull();
    expect(lastFetchAt(null)).toBeNull();
  });
});

describe("isSimplefinRangeNotice", () => {
  it("matches SimpleFIN's range notices exactly as the demo sends them", () => {
    expect(isSimplefinRangeNotice("Requested date range exceeds limit of 90 days and was capped.")).toBe(true);
    expect(
      isSimplefinRangeNotice(
        "Requested date range exceeds recommended range of 45 days. In the future, this may be capped.",
      ),
    ).toBe(true);
    expect(isSimplefinRangeNotice("  requested date range exceeds limit  ")).toBe(true);
  });
  it("never swallows a real bank problem", () => {
    expect(isSimplefinRangeNotice("Connection to Bank X may need attention")).toBe(false);
    expect(isSimplefinRangeNotice("Reauthenticate Bank Y")).toBe(false);
    expect(isSimplefinRangeNotice('Account "Visa": could not be imported because of a server error.')).toBe(false);
  });
});

describe("takeAppOpenCheck", () => {
  it("lets one check per user through per interval", () => {
    const checks = new Map<string, number>();
    const t0 = 1_000_000;
    expect(takeAppOpenCheck(checks, "u1", t0)).toBe(true);
    expect(takeAppOpenCheck(checks, "u1", t0 + 1000)).toBe(false);
    expect(takeAppOpenCheck(checks, "u2", t0 + 1000)).toBe(true);
    expect(takeAppOpenCheck(checks, "u1", t0 + APP_OPEN_CHECK_INTERVAL_MS - 1)).toBe(false);
    expect(takeAppOpenCheck(checks, "u1", t0 + APP_OPEN_CHECK_INTERVAL_MS)).toBe(true);
  });

  it("forgets the oldest user rather than growing without bound", () => {
    const checks = new Map<string, number>();
    for (let i = 0; i < 5000; i++) takeAppOpenCheck(checks, `u${i}`, i);
    expect(checks.size).toBe(5000);
    expect(takeAppOpenCheck(checks, "new", 10_000)).toBe(true);
    expect(checks.size).toBe(5000);
    expect(checks.has("u0")).toBe(false);
    expect(checks.has("new")).toBe(true);
  });
});

describe("wiring", () => {
  it("the session route offers the auto-sync to signed-in sessions only", () => {
    const src = code("src/app/api/auth/session/route.ts");
    expect(src).toMatch(
      /if \(auth\.context\.method === "account"\) \{\s*enqueueAutoSyncOnAppOpen\(auth\.context\.userId, auth\.context\.dek\);/,
    );
  });

  it("the dashboard route does not (it runs inside withOp, which would bill the sync to it)", () => {
    expect(code("src/app/api/dashboard/route.ts")).not.toContain("enqueueAutoSyncOnAppOpen");
  });

  it("the app-open entry needs the DEK and passes the in-process gate before the slot", () => {
    const src = code("src/lib/external-import/simplefin-orchestrator.ts");
    const body = src.slice(src.indexOf("export function enqueueAutoSyncOnAppOpen"));
    expect(body).toMatch(/if \(!dek\) return;[\s\S]*takeAppOpenCheck\(checks, userId\)[\s\S]*enqueueAutoSyncSimpleFin\(userId, dek\)/);
  });

  it("every fetch uses the computed window and drops SimpleFIN's range notice from both lists", () => {
    const src = code("src/lib/external-import/simplefin-orchestrator.ts");
    expect(src).not.toContain("SYNC_LOOKBACK_DAYS");
    const fetch = src.slice(src.indexOf("async function fetchAndTransform"), src.indexOf("export async function previewSimpleFin"));
    expect(fetch).toContain("simplefinWindowDays(lastFetchAt(await getSyncStatus(userId)))");
    expect(fetch).toContain("providerErrors: result.providerErrors.filter((e) => !isSimplefinRangeNotice(e))");
    expect(fetch).toContain("errors: result.errors.filter((e) => !isSimplefinRangeNotice(e))");
  });
});
