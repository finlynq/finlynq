// GENERATED LIST, edit with care. See ./README.md.
//
// Self-hosted fonts (2026-11-10). These are the exact woff2 files
// next/font/google used to download from Google at build time; they live in
// the repo now so a build never touches the network for fonts (the Google
// download failed prod deploys under Turbopack).
//
// next/font/local gives one call ONE set of @font-face descriptors, so each
// Google subset (latin, latin-ext, cyrillic, ...) is its own call carrying its
// own unicode-range. ./fonts.css joins each font's subsets back into the one
// CSS variable the app reads (--font-geist-sans, --font-inter, ...), followed
// by a size-adjusted local fallback. A browser only downloads a subset file
// when the page has a character in its range.
//
// Preloaded: the latin files of Geist, Geist Mono and Instrument Serif (the
// default UI, numerics and landing accents). The font picker's alternates
// (Inter, IBM Plex Sans, Atkinson Hyperlegible) are not preloaded.
import localFont from "next/font/local";
import "./fonts.css";

const geistLatin = localFont({
  src: "./geist/geist-latin.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--font-geist-sans-latin",
  display: "swap",
  preload: true,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD" },
  ],
});

const geistLatinExt = localFont({
  src: "./geist/geist-latin-ext.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--font-geist-sans-latin-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF" },
  ],
});

const geistVietnamese = localFont({
  src: "./geist/geist-vietnamese.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--font-geist-sans-vietnamese",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB" },
  ],
});

const geistCyrillic = localFont({
  src: "./geist/geist-cyrillic.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--font-geist-sans-cyrillic",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116" },
  ],
});

const geistCyrillicExt = localFont({
  src: "./geist/geist-cyrillic-ext.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--font-geist-sans-cyrillic-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0460-052F, U+1C80-1C8A, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F" },
  ],
});

const geistMonoLatin = localFont({
  src: "./geist-mono/geist-mono-latin.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--font-geist-mono-latin",
  display: "swap",
  preload: true,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD" },
  ],
});

const geistMonoLatinExt = localFont({
  src: "./geist-mono/geist-mono-latin-ext.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--font-geist-mono-latin-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF" },
  ],
});

const geistMonoVietnamese = localFont({
  src: "./geist-mono/geist-mono-vietnamese.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--font-geist-mono-vietnamese",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB" },
  ],
});

const geistMonoSymbols2 = localFont({
  src: "./geist-mono/geist-mono-symbols2.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--font-geist-mono-symbols2",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+2000-2001, U+2004-2008, U+200A, U+23B8-23BD, U+2500-259F" },
  ],
});

const geistMonoCyrillic = localFont({
  src: "./geist-mono/geist-mono-cyrillic.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--font-geist-mono-cyrillic",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116" },
  ],
});

const geistMonoCyrillicExt = localFont({
  src: "./geist-mono/geist-mono-cyrillic-ext.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--font-geist-mono-cyrillic-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0460-052F, U+1C80-1C8A, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F" },
  ],
});

const instrumentSerifLatin = localFont({
  src: [
    { path: "./instrument-serif/instrument-serif-latin-italic.woff2", weight: "400", style: "italic" },
    { path: "./instrument-serif/instrument-serif-latin.woff2", weight: "400", style: "normal" },
  ],
  variable: "--font-instrument-serif-latin",
  display: "swap",
  preload: true,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD" },
  ],
});

const instrumentSerifLatinExt = localFont({
  src: [
    { path: "./instrument-serif/instrument-serif-latin-ext-italic.woff2", weight: "400", style: "italic" },
    { path: "./instrument-serif/instrument-serif-latin-ext.woff2", weight: "400", style: "normal" },
  ],
  variable: "--font-instrument-serif-latin-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF" },
  ],
});

const interLatin = localFont({
  src: "./inter/inter-latin.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--font-inter-latin",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD" },
  ],
});

const interLatinExt = localFont({
  src: "./inter/inter-latin-ext.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--font-inter-latin-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF" },
  ],
});

const interVietnamese = localFont({
  src: "./inter/inter-vietnamese.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--font-inter-vietnamese",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB" },
  ],
});

const interGreek = localFont({
  src: "./inter/inter-greek.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--font-inter-greek",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0370-0377, U+037A-037F, U+0384-038A, U+038C, U+038E-03A1, U+03A3-03FF" },
  ],
});

const interGreekExt = localFont({
  src: "./inter/inter-greek-ext.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--font-inter-greek-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+1F00-1FFF" },
  ],
});

const interCyrillic = localFont({
  src: "./inter/inter-cyrillic.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--font-inter-cyrillic",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116" },
  ],
});

const interCyrillicExt = localFont({
  src: "./inter/inter-cyrillic-ext.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--font-inter-cyrillic-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0460-052F, U+1C80-1C8A, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F" },
  ],
});

const ibmPlexSansLatin = localFont({
  src: "./ibm-plex-sans/ibm-plex-sans-latin.woff2",
  weight: "400 700",
  style: "normal",
  variable: "--font-ibm-plex-sans-latin",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD" },
    { prop: "font-stretch", value: "100%" },
  ],
});

const ibmPlexSansLatinExt = localFont({
  src: "./ibm-plex-sans/ibm-plex-sans-latin-ext.woff2",
  weight: "400 700",
  style: "normal",
  variable: "--font-ibm-plex-sans-latin-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF" },
    { prop: "font-stretch", value: "100%" },
  ],
});

const ibmPlexSansVietnamese = localFont({
  src: "./ibm-plex-sans/ibm-plex-sans-vietnamese.woff2",
  weight: "400 700",
  style: "normal",
  variable: "--font-ibm-plex-sans-vietnamese",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB" },
    { prop: "font-stretch", value: "100%" },
  ],
});

const ibmPlexSansGreek = localFont({
  src: "./ibm-plex-sans/ibm-plex-sans-greek.woff2",
  weight: "400 700",
  style: "normal",
  variable: "--font-ibm-plex-sans-greek",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0370-0377, U+037A-037F, U+0384-038A, U+038C, U+038E-03A1, U+03A3-03FF" },
    { prop: "font-stretch", value: "100%" },
  ],
});

const ibmPlexSansCyrillic = localFont({
  src: "./ibm-plex-sans/ibm-plex-sans-cyrillic.woff2",
  weight: "400 700",
  style: "normal",
  variable: "--font-ibm-plex-sans-cyrillic",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116" },
    { prop: "font-stretch", value: "100%" },
  ],
});

const ibmPlexSansCyrillicExt = localFont({
  src: "./ibm-plex-sans/ibm-plex-sans-cyrillic-ext.woff2",
  weight: "400 700",
  style: "normal",
  variable: "--font-ibm-plex-sans-cyrillic-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0460-052F, U+1C80-1C8A, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F" },
    { prop: "font-stretch", value: "100%" },
  ],
});

const atkinsonHyperlegibleLatin = localFont({
  src: [
    { path: "./atkinson-hyperlegible/atkinson-hyperlegible-latin-400.woff2", weight: "400", style: "normal" },
    { path: "./atkinson-hyperlegible/atkinson-hyperlegible-latin-700.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-atkinson-latin",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD" },
  ],
});

const atkinsonHyperlegibleLatinExt = localFont({
  src: [
    { path: "./atkinson-hyperlegible/atkinson-hyperlegible-latin-ext-400.woff2", weight: "400", style: "normal" },
    { path: "./atkinson-hyperlegible/atkinson-hyperlegible-latin-ext-700.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-atkinson-latin-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF" },
  ],
});

/** Every font's CSS variable classes; put on <html> (see layout.tsx). */
export const fontVariables = [
  geistLatin.variable,
  geistLatinExt.variable,
  geistVietnamese.variable,
  geistCyrillic.variable,
  geistCyrillicExt.variable,
  geistMonoLatin.variable,
  geistMonoLatinExt.variable,
  geistMonoVietnamese.variable,
  geistMonoSymbols2.variable,
  geistMonoCyrillic.variable,
  geistMonoCyrillicExt.variable,
  instrumentSerifLatin.variable,
  instrumentSerifLatinExt.variable,
  interLatin.variable,
  interLatinExt.variable,
  interVietnamese.variable,
  interGreek.variable,
  interGreekExt.variable,
  interCyrillic.variable,
  interCyrillicExt.variable,
  ibmPlexSansLatin.variable,
  ibmPlexSansLatinExt.variable,
  ibmPlexSansVietnamese.variable,
  ibmPlexSansGreek.variable,
  ibmPlexSansCyrillic.variable,
  ibmPlexSansCyrillicExt.variable,
  atkinsonHyperlegibleLatin.variable,
  atkinsonHyperlegibleLatinExt.variable,
].join(" ");
