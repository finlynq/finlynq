import type { Metadata } from "next";
import "./landing.css";
import { LandingClient } from "@/components/landing/landing-client";
import { JsonLd, softwareApplicationSchema } from "@/components/seo/json-ld";

// Server wrapper for the landing page. The interactive UI lives in the client
// component `LandingClient`; this file owns the page metadata + JSON-LD, which
// a `"use client"` file cannot export.
export const metadata: Metadata = {
  title:
    "Finlynq: Open-Source Personal Finance with a First-Party MCP Server",
  description:
    "Open-source (AGPL v3) personal finance with a first-party MCP server. Track your money, then query it in plain English from Claude or any MCP client.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "Finlynq: track your money here, analyze it anywhere",
    description:
      "Open-source personal finance with a first-party MCP server. Connect Claude, Cursor, or any AI assistant. Per-user envelope encryption. Self-host or free cloud.",
    url: "/",
    type: "website",
    siteName: "Finlynq",
  },
  twitter: {
    card: "summary_large_image",
    title: "Finlynq: track your money here, analyze it anywhere",
    description:
      "Open-source personal finance with a first-party MCP server. Connect any AI assistant. Self-host or free cloud.",
  },
};

export default function HomePage() {
  return (
    <>
      <JsonLd data={softwareApplicationSchema()} />
      <LandingClient />
    </>
  );
}
