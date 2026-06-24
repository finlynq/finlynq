import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
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
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} ${instrumentSerif.variable} antialiased noise-bg`}>
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
