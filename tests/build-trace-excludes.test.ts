/**
 * The build must never copy runtime data into its output.
 *
 * File tracing can't resolve the dynamic path feedback attachments are written
 * to (getUploadsBaseDir() + "feedback" + user id), so it globbed the project
 * root and listed every file under uploads/feedback/** in the feedback routes'
 * .nft.json; the standalone step then copied real users' attachments into
 * .next/standalone/uploads on every build (seen on the dev box 2026-11-10).
 * server-logger's pf-server.log was traced into 233 routes the same way.
 * `outputFileTracingExcludes` in next.config.ts drops both from every route's
 * trace (it does not reach the instrumentation hook's trace, which still lists
 * pf-server.log; uploads never appear there). This pins the exclusion, and
 * pins that the excluded directory is the one the app actually writes to, so
 * moving the uploads root without moving the exclusion fails here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { readFileSync } from "node:fs";
import nextConfig from "../next.config";
import { getUploadsBaseDir } from "@/lib/uploads-dir";

const ROOT = path.resolve(__dirname, "..");
const excludes = () => nextConfig.outputFileTracingExcludes?.["*"] ?? [];

/** True when `rel` (project-relative, forward slashes) falls under a pattern. */
function excluded(rel: string): boolean {
  return excludes().some((pattern) =>
    pattern.endsWith("/**") ? rel.startsWith(pattern.slice(0, -2)) : rel === pattern,
  );
}

describe("build trace excludes", () => {
  let savedOverride: string | undefined;
  beforeEach(() => {
    savedOverride = process.env.PF_UPLOADS_DIR;
    delete process.env.PF_UPLOADS_DIR;
  });
  afterEach(() => {
    if (savedOverride === undefined) delete process.env.PF_UPLOADS_DIR;
    else process.env.PF_UPLOADS_DIR = savedOverride;
    vi.restoreAllMocks();
  });

  it("applies to every route", () => {
    expect(Object.keys(nextConfig.outputFileTracingExcludes ?? {})).toContain("*");
  });

  it("excludes the uploads directory and the server log", () => {
    expect(excludes()).toEqual(expect.arrayContaining(["uploads/**", "pf-server.log"]));
    expect(excluded("uploads/feedback/some-user/some-file.png")).toBe(true);
    expect(excluded("pf-server.log")).toBe(true);
  });

  it("excludes the directory the standalone server writes uploads to", () => {
    // On the box the server runs from <root>/.next/standalone and the build
    // runs at <root>, so the traced copy and the real files share <root>.
    vi.spyOn(process, "cwd").mockReturnValue(path.join(ROOT, ".next", "standalone"));
    const file = path.join(getUploadsBaseDir(), "feedback", "u", "a.png");
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    expect(rel.startsWith("..")).toBe(false);
    expect(excluded(rel)).toBe(true);
  });

  it("excludes the directory a local server writes uploads to", () => {
    vi.spyOn(process, "cwd").mockReturnValue(ROOT);
    const rel = path
      .relative(ROOT, path.join(getUploadsBaseDir(), "feedback", "u", "a.png"))
      .split(path.sep)
      .join("/");
    expect(excluded(rel)).toBe(true);
  });

  it("does not exclude app code", () => {
    expect(excluded("src/lib/feedback/attachment.ts")).toBe(false);
    expect(excluded("node_modules/pg/package.json")).toBe(false);
  });

  // The hints stop the glob at its source: without them every route that
  // imports the feedback code also traced every `*feedback*` source file and
  // migration into the build (measured: 1,003 + 236 entries across the traces).
  it.each([
    ["src/lib/uploads-dir.ts", /path\.join\(\s*\/\* turbopackIgnore: true \*\/\s*cwd,/g, 2],
    ["src/lib/feedback/attachment.ts", /path\.join\(\s*\/\* turbopackIgnore: true \*\//g, 2],
  ])("%s marks its runtime paths turbopackIgnore", (file, pattern, count) => {
    const src = readFileSync(path.join(ROOT, file), "utf8");
    expect(src.match(pattern)?.length ?? 0).toBe(count);
  });
});
