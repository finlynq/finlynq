import { McpGuide } from "@/components/mcp-guide/mcp-guide";

// Public, SEO-indexed "Connect Your AI" guide (metadata in ./layout.tsx).
// The interactive body lives in the shared <McpGuide> client component so the
// in-app /connect route (app shell + sidebar) can reuse it verbatim.
export default function McpGuidePage() {
  return <McpGuide />;
}
