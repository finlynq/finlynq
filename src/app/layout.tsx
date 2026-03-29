import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Nav } from "@/components/nav";
import { ThemeProvider } from "@/components/theme-provider";
import { UnlockGate } from "@/components/unlock-gate";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "PF - Personal Finance",
  description: "Track your money here, analyze it anywhere",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased noise-bg`}>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <UnlockGate>
            <div className="relative flex min-h-screen">
              <Nav />
              <main className="flex-1 overflow-auto pb-16 md:pb-0 bg-dot-pattern ambient-glow">
                <div className="relative z-10 mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
                  {children}
                </div>
              </main>
            </div>
          </UnlockGate>
        </ThemeProvider>
      </body>
    </html>
  );
}
