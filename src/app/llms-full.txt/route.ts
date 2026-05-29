import { GLOSSARY } from "@/lib/seo/glossary";
import { SITE_URL, VS_SLUGS, VS_META } from "@/lib/seo/site";

// Long-form companion to /llms.txt — the full text of the public glossary plus
// pointers to the key pages, so an LLM can ingest Finlynq's concept surface in
// one fetch. Generated at build time from the glossary data (no fs reads).
export const dynamic = "force-static";

export function GET() {
  const lines: string[] = [];

  lines.push("# Finlynq — full text for LLMs");
  lines.push("");
  lines.push(
    "> Open-source (AGPL v3) personal finance app with a first-party Model Context Protocol (MCP) server. Track income, expenses, budgets, investments, loans, and goals — then query your money in plain English from Claude, Cursor, Windsurf, or any MCP client. Per-user envelope encryption (AES-256-GCM, scrypt-derived key) means even the operator cannot read your data. Self-host with Docker or use the free managed cloud."
  );
  lines.push("");
  lines.push(`Short index: ${SITE_URL}/llms.txt`);
  lines.push(`Comparisons index: ${SITE_URL}/vs`);
  lines.push(`Glossary index: ${SITE_URL}/glossary`);
  lines.push("");

  lines.push("## Glossary");
  for (const entry of GLOSSARY) {
    lines.push("");
    lines.push(`### ${entry.term}`);
    lines.push(`Source: ${SITE_URL}/glossary/${entry.slug}`);
    lines.push("");
    lines.push(entry.description);
    for (const block of entry.blocks) {
      lines.push("");
      if (block.type === "h2") {
        lines.push(`#### ${block.text}`);
      } else if (block.type === "ul") {
        for (const item of block.items) lines.push(`- ${item}`);
      } else {
        lines.push(block.text);
      }
    }
  }

  lines.push("");
  lines.push("## Comparisons");
  for (const slug of VS_SLUGS) {
    lines.push(
      `- Finlynq vs ${VS_META[slug].name} (${SITE_URL}/vs/${slug}): ${VS_META[slug].blurb}`
    );
  }

  lines.push("");
  lines.push("## Key pages");
  lines.push(`- About / FAQ: ${SITE_URL}/about`);
  lines.push(`- MCP guide: ${SITE_URL}/mcp-guide`);
  lines.push(`- MCP tool catalog: ${SITE_URL}/mcp-guide/tools`);
  lines.push(`- Self-hosting: ${SITE_URL}/self-hosted`);
  lines.push(`- Managed cloud: ${SITE_URL}/cloud`);
  lines.push(`- Encryption writeup: ${SITE_URL}/blog/how-finlynq-encrypts-your-money`);
  lines.push(`- Source code: https://github.com/finlynq/finlynq`);
  lines.push("");

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
