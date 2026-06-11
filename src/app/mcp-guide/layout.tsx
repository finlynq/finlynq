import type { Metadata } from "next";

// `mcp-guide/page.tsx` is a client component (interactive setup tabs), so its
// metadata lives here in a server layout — same pattern as `/cloud`.
export const metadata: Metadata = {
  title:
    "Finlynq MCP guide — connect Claude, Cursor & Windsurf to your finances",
  description:
    "Connect Finlynq's first-party MCP server to Claude, Cursor, Windsurf, or any MCP client. OAuth 2.1 + Dynamic Client Registration, Bearer API key, or stdio. 102 HTTP / 93 stdio tools over your own financial data.",
  alternates: { canonical: "/mcp-guide" },
  openGraph: {
    title: "Finlynq MCP guide — connect any AI assistant to your finances",
    description:
      "Set up the Finlynq MCP server in Claude, Cursor, Windsurf, and more. OAuth 2.1, Bearer key, or stdio.",
    url: "/mcp-guide",
    type: "article",
    siteName: "Finlynq",
  },
  twitter: {
    card: "summary_large_image",
    title: "Finlynq MCP guide",
    description:
      "Connect Claude, Cursor, Windsurf and more to your Finlynq financial data.",
  },
};

export default function McpGuideLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
