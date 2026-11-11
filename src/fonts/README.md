# Self-hosted fonts

Every web font Finlynq uses ships in this folder, so `next build` never
downloads fonts. Until 2026-11-10 the app used `next/font/google`, which
fetches from Google at build time. Under Turbopack that download failed
intermittently (`Can't resolve '@vercel/turbopack-next/internal/font/google/font'`,
one error per `@font-face`, always IBM Plex Sans) and failed prod deploys.

| Folder | Font | CSS variable | Used for |
|---|---|---|---|
| `geist/` | Geist (variable, 100–900) | `--font-geist-sans` | Default UI font |
| `geist-mono/` | Geist Mono (variable, 100–900) | `--font-geist-mono` | Numbers (`.tabular-nums`, `[data-value]`) |
| `instrument-serif/` | Instrument Serif 400, normal + italic | `--font-instrument-serif` | Landing page accents |
| `inter/` | Inter (variable, 100–900) | `--font-inter` | Font picker option |
| `ibm-plex-sans/` | IBM Plex Sans (variable, 400–700) | `--font-ibm-plex-sans` | Font picker option |
| `atkinson-hyperlegible/` | Atkinson Hyperlegible 400 + 700 | `--font-atkinson` | Font picker option |

## Where the files came from

They are the unmodified woff2 files Google Fonts served on 2026-11-10 to the
user agent `next/font/google` sends (Chrome 104 on macOS), byte-identical
to what the previous build put in `.next/static/media`. Versions: Geist v5,
Geist Mono v6, Instrument Serif v5, Inter v20, IBM Plex Sans v23, Atkinson
Hyperlegible v12. All six are under the SIL Open Font License 1.1; each folder
carries the font's `OFL.txt` (from `github.com/google/fonts`, `ofl/<family>/`),
which must stay next to the files. IBM Plex Sans reserves the font name "Plex",
so don't modify those files.

## How it fits together

- **`fonts.ts`** calls `next/font/local` once per font AND subset (latin,
  latin-ext, cyrillic, ...): one call can only give all its faces the same
  descriptors, and each subset needs its own `unicode-range`. Every call sets
  its own variable (`--font-geist-sans-latin`, `--font-geist-sans-cyrillic`,
  ...); `fontVariables` joins their classes for `<html>` in `app/layout.tsx`.
- **`fonts.css`** joins each font's subsets back into the variable the app
  reads, latin first, then a local fallback (`"Geist Fallback"` etc. =
  Arial or Times New Roman with the size adjustments `next/font/google`
  computed, so text doesn't shift when the web font arrives). Calls set
  `adjustFontFallback: false` because these hand-written fallbacks replace it.
- The browser only downloads a subset file when a page contains a character in
  its range, so a Cyrillic payee fetches the Cyrillic file and nothing else.
- Preloaded: the latin files of Geist, Geist Mono and Instrument Serif. The
  picker's alternates are not preloaded; they load when picked.
- `globals.css` (`[data-font]` overrides) and `landing.css` read the joined
  variables and did not change.

## Updating or adding a font

1. Fetch `https://fonts.googleapis.com/css2?family=<Family>:<axes>&display=swap`
   with the Chrome-104-on-macOS user agent (other user agents get differently
   hinted files) and download each `url(...)` it lists.
2. Name files `<font>-<subset>[-italic|-<weight>].woff2`, add one `localFont`
   call per subset with that subset's `unicode-range` (and any other
   descriptor Google's CSS sets, e.g. IBM Plex Sans's `font-stretch: 100%`),
   add its variable to `fontVariables`, and add it to the font's list in
   `fonts.css` in the order Google's CSS implies (Google lists latin LAST and
   the last face wins, so latin goes FIRST here).
3. Add the font's `OFL.txt`. `tests/self-hosted-fonts.test.ts` checks that
   every file, variable and licence is wired up.
