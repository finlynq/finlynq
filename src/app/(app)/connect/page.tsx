import { McpGuide } from "@/components/mcp-guide/mcp-guide";

// In-app "Connect Your AI" guide. Renders the SAME shared component as the
// public /mcp-guide page, but `embedded` drops the public chrome (full-bleed
// background + analytics-consent banner) so it sits inside the app shell with
// the sidebar intact. The sidebar "MCP Guide" item links here, not to the
// public /mcp-guide route (which is outside the (app) group and would hide the
// sidebar). The public page stays for SEO; CLAUDE.md forbids re-adding an
// (app)/mcp-guide route, hence this distinct /connect path.
export default function ConnectPage() {
  return <McpGuide embedded />;
}
