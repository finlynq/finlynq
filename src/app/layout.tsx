import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Nav } from "@/components/nav";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "PF - Personal Finance",
  description: "Track your money here, analyze it anywhere",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <div className="flex min-h-screen">
          <Nav />
          <main className="flex-1 overflow-auto">
            <div className="mx-auto max-w-7xl px-6 py-8 lg:px-8">
              {children}
            </div>
          </main>
        </div>
      </body>
    </html>
  );
}
