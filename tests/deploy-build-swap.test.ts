/**
 * deploy.sh must never take the live build away before a new one exists.
 *
 * On 2026-11-10 two prod deploys failed at the on-box `next build` (a Google
 * Fonts download). deploy.sh had already moved `.next` aside and deleted it, so
 * the running server kept answering /api/healthz and / with 200 while every
 * /_next/static/* asset 500'd, until a later build succeeded. The fix builds
 * into a side directory (NEXT_DIST_DIR) and swaps it into `.next` only after
 * the build and the static copy succeeded; the previous build is removed only
 * once the new one passed the smoke check.
 *
 * Static gate over the script text, because none of this runs in CI: the
 * deploy itself is the only other test, and it tests it on the live site.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");

/** Drop whole-line comments so prose about the old behaviour can't match. */
function code(script: string): string {
  return script
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

/** Every rule the build/swap section must follow; returns the ones broken. */
function swapViolations(script: string): string[] {
  const src = code(script);
  const problems: string[] = [];

  const buildDir = src.match(/^BUILD_DIR="([^"]+)"/m)?.[1];
  if (!buildDir) return ["no BUILD_DIR assignment"];
  if (buildDir === ".next") problems.push("BUILD_DIR is the live .next");

  const builds = [...src.matchAll(/npm run build/g)].map((m) => m.index!);
  if (builds.length === 0) problems.push("no npm run build");
  const unscopedBuild = [...src.matchAll(/^.*npm run build.*$/gm)].find(
    (m) => !m[0].includes("NEXT_DIST_DIR=$BUILD_DIR"),
  );
  if (unscopedBuild) problems.push(`build not scoped to BUILD_DIR: ${unscopedBuild[0].trim()}`);
  const lastBuild = Math.max(...builds);

  // The live tree is never deleted in place, by any spelling.
  if (/rm -rf \.next(?=[\s"']|$)/m.test(src)) problems.push("rm -rf .next on the live tree");

  // The swap: .next is renamed aside, then BUILD_DIR renamed in — after the build.
  const moveAside = src.search(/mv \.next \$OLD_NEXT/);
  const moveIn = src.search(/mv \$BUILD_DIR \.next/);
  if (moveAside === -1) problems.push("no `mv .next $OLD_NEXT`");
  if (moveIn === -1) problems.push("no `mv $BUILD_DIR .next`");
  if (moveAside !== -1 && moveAside < lastBuild) problems.push(".next moved aside before the build finished");
  if (moveIn !== -1 && moveAside !== -1 && moveIn < moveAside) problems.push("swap order reversed");

  // Static + public go into the NEW bundle, before the swap.
  if (!/^BUILD_INNER="\$BUILD_DIR\/standalone\/\$BUILD_DIR"/m.test(src)) {
    problems.push("BUILD_INNER is not $BUILD_DIR/standalone/$BUILD_DIR (Next keeps the dist-dir name inside standalone)");
  }
  const staticCopy = src.search(/cp -r \$BUILD_DIR\/static \$BUILD_INNER\/static/);
  const publicCopy = src.search(/cp -r public \$BUILD_DIR\/standalone\/public/);
  if (staticCopy === -1) problems.push("static/ not copied into the new standalone bundle");
  if (publicCopy === -1) problems.push("public/ not copied into the new standalone bundle");
  if (staticCopy !== -1 && moveAside !== -1 && staticCopy > moveAside) problems.push("static copied after the swap");

  // The previous build is removed only after the smoke check passed.
  const smoke = src.search(/scripts\/smoke-check\.sh/);
  const removeOld = src.search(/rm -rf \$OLD_NEXT/);
  if (removeOld === -1) problems.push("previous build never removed");
  if (removeOld !== -1 && smoke !== -1 && removeOld < smoke) problems.push("previous build removed before the smoke check");

  return problems;
}

const DEPLOY_SH = read("deploy.sh");

describe("deploy.sh builds before it swaps", () => {
  it("follows every build/swap rule", () => {
    expect(swapViolations(DEPLOY_SH)).toEqual([]);
  });

  it("still catches the old delete-then-build order", () => {
    const old = [
      'BUILD_DIR=".next-deploy"',
      'BUILD_INNER="$BUILD_DIR/standalone/$BUILD_DIR"',
      'run_as "mv .next $OLD_NEXT"',
      'run_as "rm -rf .next"',
      'run_as "npm run build"',
      'run_as "mv $BUILD_DIR .next"',
      'run_as "cp -r .next/static .next/standalone/.next/static"',
      'run_as "rm -rf $OLD_NEXT"',
      'bash "$APP_DIR/scripts/smoke-check.sh"',
    ].join("\n");
    const v = swapViolations(old);
    expect(v).toContain("rm -rf .next on the live tree");
    expect(v.some((p) => p.startsWith("build not scoped"))).toBe(true);
    expect(v).toContain(".next moved aside before the build finished");
    expect(v).toContain("static/ not copied into the new standalone bundle");
    expect(v).toContain("previous build removed before the smoke check");
  });

  it("ignores comments that describe the old behaviour", () => {
    expect(code('# used to: rm -rf .next\necho hi')).not.toContain("rm -rf");
  });
});

describe("the build directory is wired through", () => {
  const buildDir = code(DEPLOY_SH).match(/^BUILD_DIR="([^"]+)"/m)?.[1] ?? "(no BUILD_DIR in deploy.sh)";

  it("next.config.ts takes its dist dir from NEXT_DIST_DIR", () => {
    expect(read("next.config.ts")).toMatch(/distDir:\s*process\.env\.NEXT_DIST_DIR\s*\|\|\s*"\.next"/);
  });

  it("tsconfig.json already lists the build dir's types, so `next build` doesn't rewrite it on the box", () => {
    const include: string[] = JSON.parse(read("tsconfig.json")).include;
    expect(include).toContain(`${buildDir}/types/**/*.ts`);
    expect(include).toContain(`${buildDir}/dev/types/**/*.ts`);
  });

  it("git ignores the build dir and detached old trees", () => {
    const gi = read(".gitignore");
    expect(gi).toContain(`/${buildDir}/`);
    expect(gi).toContain("/.next.old.*/");
  });
});

describe("the smoke check looks at page assets, not just healthz", () => {
  const smoke = code(read("scripts/smoke-check.sh"));

  it("fetches a /_next/static/ file linked from / and requires a 200", () => {
    expect(smoke).toMatch(/grep -oE '\/_next\/static\//);
    expect(smoke).toMatch(/fetch "\$ASSET_PATH"/);
    expect(smoke).toMatch(/\$HTTP_STATUS" != "200"[\s\S]*page asset returned/);
  });
});
