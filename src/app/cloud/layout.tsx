import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Finlynq cloud: free managed personal finance with MCP",
  description:
    "Log in or register for Finlynq's free managed cloud. There's no infrastructure to manage. It's the same code as the self-hosted edition, with a first-party MCP server and per-user envelope encryption.",
  alternates: { canonical: "/cloud" },
  openGraph: {
    title: "Finlynq cloud: free managed personal finance",
    description:
      "Free managed Finlynq, with no infrastructure to manage. It's the same features as self-host, plus a first-party MCP server.",
    url: "/cloud",
    type: "website",
    siteName: "Finlynq",
  },
  twitter: {
    card: "summary_large_image",
    title: "Finlynq cloud: free managed personal finance",
    description:
      "Free managed Finlynq with a first-party MCP server and per-user envelope encryption.",
  },
};

export default function CloudLayout({ children }: { children: React.ReactNode }) {
  return children;
}
