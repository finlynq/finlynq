import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Instrument_Serif, Inter, IBM_Plex_Sans, Atkinson_Hyperlegible } from "next/font/google";
import { headers } from "next/headers";
import { ThemeProvider } from "@/components/theme-provider";
import { JsonLd, organizationSchema } from "@/components/seo/json-ld";
import { SITE_URL } from "@/lib/seo/site";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
});
// Alternate UI fonts (FINLYNQ-225) — loaded as CSS variables; Geist is default.
const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const ibmPlexSans = IBM_Plex_Sans({
  variable: "--font-ibm-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});
const atkinsonHyperlegible = Atkinson_Hyperlegible({
  variable: "--font-atkinson",
  subsets: ["latin"],
  weight: ["400", "700"],
});

/** Inline script run before first paint to apply the stored font preference.
 *  Mirrors next-themes FOUC pattern — nonce carried by the <script> tag.
 *  storageKey must match FONT_STORAGE_KEY in font-provider.tsx. */
const FONT_FOUC_SCRIPT = `(function(){try{var k=localStorage.getItem("pf-font");var v=["geist","inter","ibm-plex-sans","atkinson","system"];if(k&&v.indexOf(k)!==-1&&k!=="geist"){document.documentElement.setAttribute("data-font",k)}}catch(e){}})();`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Finlynq: open-source personal finance with a first-party MCP server",
  description:
    "Finlynq: open-source personal finance with a first-party MCP server. Free hosted at finlynq.com/cloud, or self-host with Docker. AGPL v3.",
  applicationName: "Finlynq",
  keywords: [
    "personal finance",
    "open source personal finance",
    "self-hosted personal finance",
    "MCP server",
    "Model Context Protocol",
    "budgeting app",
    "Claude personal finance",
    "AGPL personal finance",
  ],
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
  },
  openGraph: {
    type: "website",
    siteName: "Finlynq",
    locale: "en_US",
    url: "/",
    title: "Finlynq: track your money here, analyze it anywhere",
    description:
      "Open-source personal finance with a first-party MCP server. Connect Claude, Cursor, or any AI assistant. Per-user envelope encryption. Self-host or free cloud.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Finlynq: track your money here, analyze it anywhere",
    description:
      "Open-source personal finance with a first-party MCP server. Connect any AI assistant. Self-host or free cloud.",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0b0e11" },
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Per-request CSP nonce set by middleware (B10 / finding C-8). Forwarded
  // to next-themes so its FOUC-prevention inline script carries the nonce.
  // Falls back to undefined if middleware didn't run (e.g. static export);
  // next-themes treats `undefined` as "no nonce".
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    // Font CSS variables (next/font) MUST live on <html> so they exist at :root —
    // globals.css consumes them via --font-sans + the [data-font] overrides, which
    // apply at :root/<html>. CSS custom properties inherit DOWN, not up; on <body>
    // they'd be invisible to :root and --font-sans would resolve to nothing
    // (FINLYNQ-225 cycle-2 fix).
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${instrumentSerif.variable} ${inter.variable} ${ibmPlexSans.variable} ${atkinsonHyperlegible.variable}`}
    >
      {/* FOUC-prevention for font preference (FINLYNQ-225).
          Runs before paint, sets data-font on <html> from localStorage.
          nonce required by strict-dynamic CSP (mirrors next-themes pattern). */}
      <head>
        <script
          suppressHydrationWarning
          nonce={typeof window === "undefined" ? nonce : ""}
          dangerouslySetInnerHTML={{ __html: FONT_FOUC_SCRIPT }}
        />
      </head>
      <body className="antialiased noise-bg">
        <JsonLd data={organizationSchema()} />
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
          nonce={nonce}
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
