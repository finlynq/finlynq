/**
 * Fonts are self-hosted from src/fonts (2026-11-10).
 *
 * next/font/google downloads from Google at build time, and under Turbopack
 * that download failed prod deploys intermittently. This pins that nothing
 * goes back to it, and that src/fonts stays wired up: every file a
 * next/font/local call names exists, every per-subset variable is joined into
 * its font's variable in fonts.css (a subset left out of the join would never
 * render, silently), every variable the app's CSS reads is defined, every font
 * folder carries its OFL licence, and the picker's alternates aren't preloaded.
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

const ROOT = path.resolve(__dirname, "..");
const FONTS_DIR = path.join(ROOT, "src", "fonts");
const fontsTs = readFileSync(path.join(FONTS_DIR, "fonts.ts"), "utf8");
const fontsCss = readFileSync(path.join(FONTS_DIR, "fonts.css"), "utf8");

/** Every .ts/.tsx/.css file under a directory. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(tsx?|css)$/.test(name) ? [full] : [];
  });
}

/** Each localFont({...}) call: its identifier and its option text. */
const calls = [...fontsTs.matchAll(/const (\w+) = localFont\(\{([\s\S]*?)\n\}\);/g)].map(
  (m) => ({ ident: m[1], body: m[2] }),
);
const callVar = (body: string) => body.match(/variable: "(--[\w-]+)"/)?.[1];

/** fonts.css: joined variable -> the per-subset variables it lists. */
const joined = new Map(
  [...fontsCss.matchAll(/(--font-[\w-]+):\s*([^;]+);/g)].map((m) => [
    m[1],
    [...m[2].matchAll(/var\((--[\w-]+)\)/g)].map((v) => v[1]),
  ]),
);

describe("self-hosted fonts", () => {
  it("nothing imports next/font/google", () => {
    const offenders = sourceFiles(path.join(ROOT, "src")).filter((f) =>
      /from\s+["']next\/font\/google["']/.test(readFileSync(f, "utf8")),
    );
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it("layout.tsx puts the font classes on <html>", () => {
    const layout = readFileSync(path.join(ROOT, "src", "app", "layout.tsx"), "utf8");
    expect(layout).toMatch(/import \{ fontVariables \} from "@\/fonts\/fonts"/);
    expect(layout).toMatch(/<html[^>]*className=\{fontVariables\}/);
  });

  it("finds every localFont call, and lists each in fontVariables", () => {
    expect(calls.length).toBeGreaterThanOrEqual(6);
    const listed = fontsTs.slice(fontsTs.indexOf("export const fontVariables"));
    for (const { ident } of calls) expect(listed).toContain(`${ident}.variable,`);
  });

  it("every file a call names exists", () => {
    const paths = [...fontsTs.matchAll(/(?:src|path): "(\.\/[^"]+)"/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThanOrEqual(calls.length);
    for (const p of paths) expect(existsSync(path.join(FONTS_DIR, p)), p).toBe(true);
  });

  it("every call carries its own unicode-range and leaves the fallback to fonts.css", () => {
    for (const { ident, body } of calls) {
      expect(body, ident).toMatch(/prop: "unicode-range", value: "U\+/);
      expect(body, ident).toMatch(/adjustFontFallback: false/);
    }
  });

  it("every per-subset variable is joined into exactly one font variable, and nothing else", () => {
    const declared = calls.map(({ body }) => callVar(body));
    const used = [...joined.values()].flat();
    expect(new Set(declared).size).toBe(declared.length);
    expect([...used].sort()).toEqual([...declared].sort());
  });

  it("each font variable starts with its latin subset and ends with its fallback", () => {
    for (const [cssVar, parts] of joined) {
      expect(parts[0], cssVar).toBe(`${cssVar}-latin`);
      const decl = fontsCss.match(new RegExp(`${cssVar}:\\s*([^;]+);`))![1];
      const fallback = decl.trim().split(",").pop()!.trim();
      expect(fallback, cssVar).toMatch(/^"[^"]+ Fallback"$/);
      expect(fontsCss).toContain(`font-family: ${fallback};`);
    }
  });

  it("defines every font variable the app's CSS reads", () => {
    const appCss = ["globals.css", "landing.css"]
      .map((f) => readFileSync(path.join(ROOT, "src", "app", f), "utf8"))
      .join("\n");
    const read = new Set([...appCss.matchAll(/var\((--font-[\w-]+)\)/g)].map((m) => m[1]));
    read.delete("--font-sans"); // the picker's runtime variable, set in globals.css
    read.delete("--font-mono");
    expect(read.size).toBeGreaterThan(0);
    for (const v of read) expect(joined.has(v), v).toBe(true);
  });

  it("every font folder carries its OFL licence", () => {
    const folders = readdirSync(FONTS_DIR).filter((n) =>
      statSync(path.join(FONTS_DIR, n)).isDirectory(),
    );
    expect(folders.length).toBe(joined.size);
    for (const folder of folders) {
      const ofl = path.join(FONTS_DIR, folder, "OFL.txt");
      expect(existsSync(ofl), folder).toBe(true);
      expect(readFileSync(ofl, "utf8")).toContain("SIL OPEN FONT LICENSE Version 1.1");
    }
  });

  it("preloads only the latin files of the default fonts, never a picker alternate", () => {
    const preloaded = calls
      .filter(({ body }) => /preload: true/.test(body))
      .map(({ body }) => callVar(body));
    expect(preloaded.sort()).toEqual(
      ["--font-geist-mono-latin", "--font-geist-sans-latin", "--font-instrument-serif-latin"].sort(),
    );
  });
});
